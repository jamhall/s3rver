"use strict";

const statuses = require("statuses");
const { format } = require("util");

const { getObject } = require("../controllers/object");
const S3Error = require("../models/error");

exports = module.exports = () =>
  async function website(ctx, next) {
    const [bucket] = ctx.path.slice(1).split("/");
    const config = await ctx.store.retrieveSubresource(
      bucket,
      undefined,
      "website"
    );
    if (config) {
      ctx.state.websiteConfig = config;
    }
    let isVirtualHost;

    if (ctx.hostname.match(/\.s3-website[-.].+\.amazonaws\.com$/)) {
      // requests to the .s3-website-<region>.amazonaws.com can throw website-specific errors
      ctx.onerror = onerror;
      isVirtualHost = true;
      if (!config) {
        throw new S3Error(
          "NoSuchWebsiteConfiguration",
          "The specified bucket does not have a website configuration",
          { BucketName: bucket }
        );
      }
    } else if (
      ctx.hostname.match(/(^|\.)s3([-.].+)?\.amazonaws\.com$/) ||
      !bucket ||
      // NOTE: This allows web browsers to experience static website behavior while maintaining
      // SDK compatibility. Real S3 doesn't care about the accepted content or bucket config.
      ctx.accepts("application/xml", "text/html") !== "text/html" ||
      !config
    ) {
      // requests to the the API endpoint use normal output behavior
      // (vhost-style buckets without website configurations also always use this behavior)
      return next();
    } else {
      ctx.onerror = onerror;
    }

    try {
      if (ctx.path.slice(1 + bucket.length) === "/") {
        throw new S3Error("NoSuchKey", "", { Key: "" });
      }
      await next();
    } catch (err) {
      if (err.code !== "NoSuchKey") throw err;

      const key = err.detail.Key;

      if (key === "" || key.endsWith("/")) {
        ctx.params = {
          bucket,
          key: key + config.indexDocumentSuffix
        };
        await getObject(ctx);
      } else {
        // Redirect keys without a trailing slash when an index document exists
        if (
          await ctx.store.existsObject(
            bucket,
            `${key}/${config.indexDocumentSuffix}`
          )
        ) {
          if (isVirtualHost) {
            ctx.redirect(`/${key}/`);
          } else {
            // This isn't possible on real S3, but for convenience this allows website
            // redirects without setting up virtual hosts
            ctx.redirect(`/${bucket}/${key}/`);
          }
        } else {
          err.detail.Key = `${key}/${config.indexDocumentSuffix}`;
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

  if (!(err instanceof S3Error)) {
    err = S3Error.fromError(err);
  }

  // first unset all headers
  res
    .getHeaderNames()
    .filter(name => !name.match(/^access-control-|vary|x-amz-/i))
    .forEach(name => res.removeHeader(name));

  // (the presence ignore x-amz-error-* headers needs additional research)
  // this.set(err.headers);

  // force text/html
  this.type = "text/html";

  if (!err.description)
    err.description = `${err.status} ${statuses[err.status]}`;

  // respond
  const { websiteConfig = {} } = this.state;
  if (err.code !== "NoSuchBucket" && websiteConfig.errorDocumentKey) {
    // attempt to serve error document
    const object = await this.store.getObject(
      this.params.bucket,
      websiteConfig.errorDocumentKey
    );
    if (object) {
      this.type = object.metadata["content-type"];
      this.length = object.size;
      object.content.pipe(res);
      return;
    }
    this.logger.error(
      "Custom Error Document not found: " + websiteConfig.errorDocumentKey
    );
    const errorDocumentErr = new S3Error(
      "NoSuchKey",
      "The specified key does not exist.",
      { Key: websiteConfig.errorDocumentKey }
    );
    errorDocumentErr.description =
      "An Error Occurred While Attempting to Retrieve a Custom Error Document";
    err.errors.push(errorDocumentErr);
  }

  const msg = err.toHTML();
  this.status = err.status;
  this.length = Buffer.byteLength(msg);
  res.end(msg);
}
