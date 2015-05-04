'use strict';
var App = require('./app');
var S3rver = function () {
  this.port = 4578;
  this.hostname = 'localhost';
  this.silent = false;
  this.indexDocument = '';
  this.errorDocument = '';
};

S3rver.prototype.setPort = function (port) {
  this.port = port;
  return this;
};

S3rver.prototype.setHostname = function (hostname) {
  this.hostname = hostname;
  return this;
};

S3rver.prototype.setDirectory = function (directory) {
  this.directory = directory;
  return this;
};

S3rver.prototype.setSilent = function (silent) {
  this.silent = silent;
  return this;
};

S3rver.prototype.setIndexDocument = function (indexDocument) {
  this.indexDocument = indexDocument;
  return this;
};

S3rver.prototype.setErrorDocument = function (errorDocument) {
  this.errorDocument = errorDocument;
  return this;
};

S3rver.prototype.run = function (done) {
  var app = new App(this.hostname, this.port, this.directory, this.silent, this.indexDocument, this.errorDocument);
  return app.serve(done);

};

module.exports = S3rver;
