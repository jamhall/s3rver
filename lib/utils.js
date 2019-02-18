"use strict";

const fs = require("fs-extra");
const path = require("path");
const { PassThrough } = require("stream");
const xmlParser = require("fast-xml-parser");

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

exports.capitalizeHeader = function(header) {
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

exports.getXmlRootTag = function(xml) {
  const traversal = xmlParser.getTraversalObj(xml.toString());
  const [[root]] = Object.values(traversal.child);
  return root && root.tagname;
};
