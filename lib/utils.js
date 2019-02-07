"use strict";

const async = require("async");
const fs = require("fs-extra");
const path = require("path");
const { PassThrough } = require("stream");

// Gathered from http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
exports.walk = function(dir) {
  const results = [];

  for (const filename of fs.readdirSync(dir)) {
    const filePath = path.posix.join(dir, filename);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      results.push(filePath, ...exports.walk(filePath, fs));
    }
  }

  return results;
};

function removeEmptyDirectoryTree(directory, callback) {
  fs.readdir(directory, (err, list) => {
    if (err)
      return callback(err.code !== "ENOTDIR" && err.code !== "ENOENT" && err);
    async.eachSeries(
      list.map(item => path.join(directory, item)),
      removeEmptyDirectoryTree,
      err => {
        if (err) return callback(err);
        // check if the current directory is empty now
        fs.readdir(directory, (err, list) => {
          if (err)
            return callback(
              err.code !== "ENOTDIR" && err.code !== "ENOENT" && err
            );
          if (list.length) return callback();
          return fs.rmdir(directory, callback);
        });
      }
    );
  });
}

// Walk a directory and remove every folder that is empty inside it (but not it itself)
exports.clearEmptyDirectoryTree = function(directory, done) {
  fs.readdir(directory, (err, list) => {
    if (err) return done(err);
    async.eachSeries(
      list.map(item => path.join(directory, item)),
      removeEmptyDirectoryTree,
      done
    );
  });
};

exports.normalizeHeader = function(header) {
  const exceptions = {
    "content-md5": "Content-MD5",
    dnt: "DNT",
    etag: "ETag",
    "last-event-id": "Last-Event-ID",
    tcn: "TCN",
    te: "TE",
    "www-authenticate": "WWW-Authenticate",
    "x-dnsprefetch-control": "X-DNSPrefetch-Control"
  };

  header = header.toLowerCase();

  if (header in exceptions) return exceptions[header];
  if (header.startsWith("x-amz-")) return header;

  // Capitalize the first letter of each word
  return header
    .split("-")
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join("-");
};

exports.concatStreams = function(streams) {
  const passThrough = new PassThrough();
  streams = [...streams];
  const pipeNext = stream => {
    if (!stream) return passThrough.end();

    stream.once("end", () => pipeNext(streams.shift()));
    stream.pipe(
      passThrough,
      { end: false }
    );
  };
  pipeNext(streams.shift());
  return passThrough;
};

exports.thunkToPromise = function(fn) {
  return new Promise((resolve, reject) => {
    fn((err, ...args) => {
      if (err) return reject(err);
      resolve(args.length > 1 ? args : args[0]);
    });
  });
};
