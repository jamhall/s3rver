"use strict";

const async = require("async");
const fs = require("fs-extra");
const path = require("path");

// Gathered from http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
exports.walk = function(dir) {
  const path = require("path");
  const url = require("url");
  let results = [];
  const list = fs.readdirSync(dir);

  list.forEach(function(file) {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results.push(url.resolve(file, ""));
      results = results.concat(exports.walk(file, fs));
    }
  });

  return results;
};

// Walk a directory and remove every folder that is empty inside it
exports.removeEmptyDirectories = function(fs, directory, done) {
  fs.stat(directory, (err, stat) => {
    if (err) return done(err);
    if (!stat.isDirectory()) return done();
    fs.readdir(directory, (err, list) => {
      if (err) return done(err);
      if (!list.length) return fs.rmdir(directory, done);
      async.eachSeries(
        list,
        (item, callback) => {
          const filename = path.join(directory, item);
          exports.removeEmptyDirectories(fs, filename, callback);
        },
        done
      );
    });
  });
};
