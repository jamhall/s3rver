"use strict";

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
      .on("close", () => {
        app.logger.unhandleExceptions();
        app.logger.close();
        if (this.options.removeBucketsOnClose) {
          this.resetFs();
        }
      })
      .on("error", done);
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
