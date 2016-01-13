'use strict';
var App = require('./app');
var _ = require('lodash');

var S3rver = function (options) {
  this.options = {
    port: 4578,
    hostname: 'localhost',
    silent: false,
    indexDocument: '',
    errorDocument: '',
    fs: require('fs-extra')
  };

  if (options) {
    this.options = _.merge(options, options);
  }

};

S3rver.prototype.setPort = function (port) {
  this.options.port = port;
  return this;
};

S3rver.prototype.setHostname = function (hostname) {
  this.options.hostname = hostname;
  return this;
};

S3rver.prototype.setDirectory = function (directory) {
  this.options.directory = directory;
  return this;
};

S3rver.prototype.setSilent = function (silent) {
  this.options.silent = silent;
  return this;
};

S3rver.prototype.setIndexDocument = function (indexDocument) {
  this.options.indexDocument = indexDocument;
  return this;
};

S3rver.prototype.setErrorDocument = function (errorDocument) {
  this.options.errorDocument = errorDocument;
  return this;
};

S3rver.prototype.setFs = function (fs) {
  this.options.fs = fs;
  return this;
};



S3rver.prototype.run = function (done) {
  var app = new App(this.options);
  return app.serve(done);

};

module.exports = S3rver;
