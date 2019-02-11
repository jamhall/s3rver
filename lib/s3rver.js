"use strict";

const fs = require("fs-extra");
const { defaults } = require("lodash");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { callbackify, promisify } = require("util");

const App = require("./app");

class S3rver {
  constructor(options) {
    this.options = defaults({}, options, S3rver.defaultOptions);
  }

  resetFs() {
    const { directory } = this.options;
    const buckets = fs.readdirSync(directory);
    for (const bucket of buckets) {
      fs.removeSync(path.join(directory, bucket));
    }
  }

  callback() {
    return new App(this.options);
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
      const app = new App(this.options);
      this.s3Event = app.s3Event;
      this.httpServer = await new Promise((resolve, reject) => {
        const { hostname, port, key, cert, pfx } = this.options;
        const httpModule = (key && cert) || pfx ? https : http;
        const server = httpModule
          .createServer({ key, cert, pfx }, app)
          .listen(port, hostname, err => (err ? reject(err) : resolve(server)))
          .on("request", app)
          .on("close", () => {
            app.logger.exceptions.unhandle();
            app.logger.close();
            if (this.options.removeBucketsOnClose) {
              this.resetFs();
            }
          });
      });
      return this.httpServer.address();
    };

    if (typeof callback === "function") {
      callbackify(runAsync)(callback);
      return this;
    } else {
      return runAsync();
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
S3rver.prototype.getMiddleware = S3rver.prototype.callback;

module.exports = S3rver;
