'use strict';

const fs = require('fs-extra');
const path = require('path');
const async = require('async');
const _ = require('lodash');
const App = require('./app');
const utils = require('./utils');

const S3rver = function (options) {
  this.options = _.defaults({}, options, S3rver.defaultOptions);
};

S3rver.prototype.resetFs = function (callback) {
  const { directory } = this.options;
  fs.readdir(directory, function (err, buckets) {
    if (err) return callback(err);
    async.eachSeries(buckets, function (bucket, callback) {
      fs.remove(path.join(directory, bucket), callback);
    }, callback);
  });
}

S3rver.prototype.getMiddleware =
S3rver.prototype.callback = function () {
  return new App(this.options);
}

S3rver.prototype.run = function (done) {
  const app = new App(this.options);
  let server = ((this.options.key && this.options.cert) || this.options.pfx)
      ? https.createServer(this.options, app)
      : app;
  server = server.listen(this.options.port, this.options.hostname, (err) => {
    done(err, this.options.hostname, this.options.port, this.options.directory);
  }).on('error', (err) => {
    done(err);
  });
  if (this.options.removeBucketsOnClose) {
    const close = server.close;
    server.close = (callback) => {
      return close.call(server, () => {
        this.resetFs(callback);
      });
    };
  }
  return server;
};

S3rver.defaultOptions = {
  port: 4578,
  hostname: 'localhost',
  silent: false,
  indexDocument: '',
  errorDocument: '',
  removeBucketsOnClose: false
};

module.exports = S3rver;
