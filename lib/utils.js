'use strict';
var path = require('path');
var async = require('async')

// Gathered from http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
exports.walk = function (dir, fs) {
  var path = require('path');
  var url = require('url');
  var results = [];
  var list = fs.readdirSync(dir);

  list.forEach(function (file) {
    file = path.join(dir, file);
    var stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results.push(url.resolve(file, ''));
      results = results.concat(exports.walk(file, fs));
    }
  });

  return results;
};

// remove a path recursively (async)
function rmdir (fs, directory, callback) {
  fs.readdir(directory, function (err, list) {
    if (err) return callback(err);
    async.eachSeries(list, function (item, callback) {
      var filename = path.join(directory, item);
      fs.stat(filename, function (err, stat) {
        if (err) return callback(err);
        if (filename === '.' || filename === '..') return callback();
        if (stat.isDirectory()) return rmdir(fs, filename, callback);
        fs.unlink(filename, callback);
      });
    }, function () {
      fs.rmdir(directory, callback);
    });
  });
};

// Walk a directory and remove every folder that is empty inside it
function removeEmptyDirectories(fs, directory, callback) {
  fs.stat(directory, function (err, stat) {
    if (err) return callback(err);
    if (!stat.isDirectory()) return callback();
    fs.readdir(directory, function (err, list) {
      if (err) return callback(err);
      if (list.length === 0) {
        return fs.rmdir(directory, callback);
      }
      async.eachSeries(list, function (item, callback) {
        var filename = path.join(directory, item);
        removeEmptyDirectories(fs, filename, callback);
      }, callback);
    });
  });
}

exports.rmdir = rmdir;
exports.removeEmptyDirectories = removeEmptyDirectories;
