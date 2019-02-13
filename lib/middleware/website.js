"use strict";

const statuses = require("statuses");
const { format } = require("util");

const { getObject } = require("../controllers/object");

module.exports = (indexDocument, errorDocument) => {
  return async function website(ctx, next) {
    const [bucket] = ctx.path.slice(1).split("/");
    let isVirtualHost;

    if (ctx.hostname.match(/\.s3-website[-.].+\.amazonaws\.com$/)) {
      // requests to the .s3-website-<region>.amazonaws.com can throw website-specific errors
      ctx.onerror = onerror;
      isVirtualHost = true;
      if (!indexDocument) {
        ctx.throw(
          404,
          "The specified bucket does not have a website configuration",
          { code: "NoSuchWebsiteConfiguration", detail: { BucketName: bucket } }
        );
      }
    } else if (
      ctx.hostname.match(/(^|\.)s3([-.].+)?\.amazonaws\.com$/) ||
      !bucket ||
      // NOTE: This allows web browsers to experience static website behavior while maintaining
      // SDK compatibility. Real S3 doesn't care about the accepted content or bucket config.
      ctx.accepts("application/xml", "text/html") !== "text/html" ||
      !indexDocument
    ) {
      // requests to the the API endpoint use normal output behavior
      // (vhost-style buckets without website configurations also always use this behavior)
      return next();
    } else {
      ctx.onerror = onerror;
    }

    try {
      if (ctx.path.slice(1 + bucket.length) === "/") {
        ctx.throw(404, { code: "NoSuchKey", detail: { Key: "" } });
      }
      await next();
    } catch (err) {
      if (err.code !== "NoSuchKey") throw err;

      const key = err.detail.Key;

      if (key === "" || key.endsWith("/")) {
        ctx.params = {
          bucket,
          key: key + indexDocument
        };
        await getObject(ctx);
      } else {
        // Redirect keys without a trailing slash when an index document exists
        if (await ctx.store.existsObject(bucket, `${key}/${indexDocument}`)) {
          if (isVirtualHost) {
            ctx.redirect(`/${key}/`);
          } else {
            // This isn't possible on real S3, but for convenience this allows website
            // redirects without setting up virtual hosts
            ctx.redirect(`/${bucket}/${key}/`);
          }
        } else {
          err.detail.Key = `${key}/${indexDocument}`;
          throw err;
        }
      }
    }
  };

  /**
   * Koa context.onerror handler modified to write a HTML-formatted response body
   * @param {Error} err
   */
  async function onerror(err) {
    // don't do anything if there is no error.
    // this allows you to pass `this.onerror`
    // to node-style callbacks.
    if (null == err) return;

    if (!(err instanceof Error))
      err = new Error(format("non-error thrown: %j", err));

    let headerSent = false;
    if (this.headerSent || !this.writable) {
      headerSent = err.headerSent = true;
    }

    // delegate
    this.app.emit("error", err, this);

    // nothing we can do here other
    // than delegate to the app-level
    // handler and log.
    if (headerSent) {
      return;
    }

    const { res } = this;

    // first unset all headers
    res.getHeaderNames().forEach(name => res.removeHeader(name));

    // then set those specified
    this.set("x-amz-error-code", err.code);
    this.set("x-amz-error-message", err.message);
    for (const [key, value] of Object.entries(err.detail || {})) {
      this.set(`x-amz-error-detail-${key}`, value);
    }
    this.set(err.headers);

    // force text/html
    this.type = "text/html";

    // default to 500
    if ("number" !== typeof err.status || !statuses[err.status])
      err.status = 500;

    if (!err.description)
      err.description = `${err.status} ${statuses[err.status]}`;

    if (!err.errors) err.errors = [];

    // respond
    if (err.code !== "NoSuchBucket" && errorDocument) {
      // attempt to serve error document
      const object = await this.store.getObject(
        this.params.bucket,
        errorDocument
      );
      if (object) {
        this.type = object.metadata["content-type"];
        this.length = object.size;
        object.content.pipe(res);
        return;
      }
      this.logger.error("Custom Error Document not found: " + errorDocument);
      err.errors.push(
        Object.assign(new Error("The specified key does not exist."), {
          code: "NoSuchKey",
          description:
            "An Error Occurred While Attempting to Retrieve a Custom Error Document",
          detail: { Key: errorDocument }
        })
      );
    }

    const msg = err.expose
      ? htmlErrorResponse(err)
      : htmlErrorResponse({
          description: err.description,
          status: err.status,
          code: "InternalError",
          message: "We encountered an internal error. Please try again."
        });
    this.status = err.status;
    this.length = Buffer.byteLength(msg);
    res.end(msg);
  }
};

function htmlErrorResponse(err) {
  return [
    // Real S3 doesn't respond with DOCTYPE
    "<html>",
    // prettier-ignore
    `<head><title>${err.description}</title></head>`,
    "<body>",
    `<h1>${err.description}</h1>`,
    "<ul>",
    `<li>Code: ${err.code}</li>`,
    `<li>Message: ${err.message}</li>`,
    Object.entries(err.detail || {})
      .map(([key, value]) => `<li>${key}: ${value}</li>`)
      .join("\n"),
    "</ul>",
    (err.errors || [])
      .map(error =>
        [
          `<h3>${error.description}</h3>`,
          "<ul>",
          `<li>Code: ${err.code}</li>`,
          `<li>Message: ${err.message}</li>`,
          Object.entries(error.detail || {})
            .map(([key, value]) => `<li>${key}: ${value}</li>`)
            .join("\n"),
          "</ul>"
        ].join("\n")
      )
      .join("\n"),
    "<hr/>",
    "</body>",
    "</html>",
    "" // trailing newline
  ].join("\n");
}
