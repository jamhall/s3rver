"use strict";

const async = require("async");
const fs = require("fs-extra");
const { defaults } = require("lodash");
const https = require("https");
const os = require("os");
const path = require("path");

const App = require("./app");

class S3rver {
  constructor(options) {
    this.options = defaults({}, options, S3rver.defaultOptions);
  }

  resetFs(callback) {
    const { directory } = this.options;
    fs.readdir(directory, (err, buckets) => {
      if (err) return callback(err);
      async.eachSeries(
        buckets,
        (bucket, callback) => {
          fs.remove(path.join(directory, bucket), callback);
        },
        callback
      );
    });
  }

  callback() {
    return new App(this.options);
  }

  run(done) {
    const app = new App(this.options);
    let server =
      (this.options.key && this.options.cert) || this.options.pfx
        ? https.createServer(this.options, app)
        : app;
    server = server
      .listen(this.options.port, this.options.hostname, err => {
        done(
          err,
          this.options.hostname,
          server.address().port,
          this.options.directory
        );
      })
      .on("error", err => {
        done(err);
      });
    server.close = callback => {
      const { close } = Object.getPrototypeOf(server);
      return close.call(server, () => {
        app.logger.unhandleExceptions();
        app.logger.close();
        if (this.options.removeBucketsOnClose) {
          this.resetFs(callback);
        } else {
          callback();
        }
      });
    };
    server.s3Event = app.s3Event;
    return server;
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
