"use strict";

const xmlParser = require("fast-xml-parser");
const fs = require("fs-extra");
const Koa = require("koa");
const { defaults, isPlainObject } = require("lodash");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const statuses = require("statuses");
const { callbackify, format, promisify } = require("util");

const corsMiddleware = require("./middleware/cors");
const loggerMiddleware = require("./middleware/logger");
const vhostMiddleware = require("./middleware/vhost");
const websiteMiddleware = require("./middleware/website");
const FilesystemStore = require("./stores/filesystem");
const router = require("./routes");

class S3rver extends Koa {
  constructor(options) {
    super();
    this.context.onerror = onerror;
    const {
      silent,
      directory,
      removeBucketsOnClose,
      cors,
      indexDocument,
      errorDocument,
      ...serverOptions
    } = defaults({}, options, S3rver.defaultOptions);
    this.serverOptions = serverOptions;
    this.silent = silent;
    this.removeBucketsOnClose = removeBucketsOnClose;
    this.store = this.context.store = new FilesystemStore(directory);

    // Log all requests
    this.use(loggerMiddleware(this, silent));

    try {
      // encode object responses as XML
      const parser = new xmlParser.j2xParser({
        ignoreAttributes: false,
        attrNodeName: "$"
      });
      this.use(async (ctx, next) => {
        await next();
        if (isPlainObject(ctx.body)) {
          ctx.type = "application/xml";
          ctx.body =
            '<?xml version="1.0" encoding="UTF-8"?>\n' + parser.parse(ctx.body);
        }
      });

      this.use(vhostMiddleware());
      this.use(corsMiddleware(cors));
      this.use(websiteMiddleware(indexDocument, errorDocument));
      this.use(router.routes());
    } catch (err) {
      this.logger.exceptions.unhandle();
      this.logger.close();
      throw err;
    }
  }

  reset() {
    this.store.reset();
  }

  /**
   * Starts the HTTP server.
   *
   * @param {Function} [callback] Function called with (err, addressObj) as arguments.
   * @returns {this|Promise} The S3rver instance. If no callback function is supplied, a Promise
   *   is returned.
   */
  run(callback) {
    const runAsync = async () => {
      const { hostname, port, ...listenOptions } = this.serverOptions;
      this.httpServer = await this.listen(port, hostname, listenOptions);
      return this.httpServer.address();
    };

    if (typeof callback === "function") {
      callbackify(runAsync)(callback);
      return this;
    } else {
      return runAsync();
    }
  }

  listen(...args) {
    const { key, cert, pfx } = this.serverOptions;
    const httpModule = (key && cert) || pfx ? https : http;

    const [callback] = args.slice(-1);

    const server = httpModule
      .createServer(this.serverOptions)
      .on("request", this.callback())
      .on("close", () => {
        this.logger.exceptions.unhandle();
        this.logger.close();
        if (this.removeBucketsOnClose) {
          this.reset();
        }
      });
    if (typeof callback === "function") {
      return server.listen(...args);
    } else {
      return new Promise((resolve, reject) =>
        server.listen(...args, err => (err ? reject(err) : resolve(server)))
      );
    }
  }

  /**
   * Proxies httpServer.close().
   *
   * @param {Function} [callback]
   * @returns {this|Promise}
   */
  close(callback) {
    if (!this.httpServer) {
      const err = new Error("Not running");
      if (typeof callback === "function") {
        callback(err);
        return this;
      } else {
        return Promise.reject(err);
      }
    }
    if (typeof callback === "function") {
      this.httpServer.close(callback);
    } else {
      return promisify(this.httpServer.close.bind(this.httpServer))();
    }
  }
}
S3rver.defaultOptions = {
  port: 4578,
  hostname: "localhost",
  silent: false,
  cors: fs.readFileSync(path.resolve(__dirname, "../cors_sample_policy.xml")),
  directory: path.join(os.tmpdir(), "s3rver"),
  indexDocument: "",
  errorDocument: "",
  removeBucketsOnClose: false
};
S3rver.prototype.middleware = S3rver.prototype.callback;

module.exports = S3rver;

/**
 * Koa context.onerror handler modified to write a XML-formatted response body
 * @param {Error} err
 */
function onerror(err) {
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
  this.set(err.headers);

  // force application/xml
  this.type = "application/xml";

  // default to 500
  if ("number" !== typeof err.status || !statuses[err.status]) err.status = 500;

  // respond
  const parser = new xmlParser.j2xParser();
  const msg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' + err.expose
      ? parser.parse({
          Error: {
            Code: err.code,
            Message: err.message,
            ...err.details
          }
        })
      : parser.parse({
          Error: {
            Code: "InternalError",
            Message: "We encountered an internal error. Please try again."
          }
        });
  this.status = err.status;
  this.length = Buffer.byteLength(msg);
  res.end(msg);
}
