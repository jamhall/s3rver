"use strict";

const fs = require("fs-extra");
const path = require("path");
const { PassThrough } = require("stream");
const xmlParser = require("fast-xml-parser");

exports.walk = function* walk(dir) {
  for (const filename of fs.readdirSync(dir)) {
    const filePath = path.posix.join(dir, filename);
    const stats = fs.statSync(filePath);
    if (!stats.isDirectory()) {
      yield filePath;
    } else {
      yield* walk(filePath);
    }
  }
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

/**
 * Inserts separators into AWS ISO8601 formatted-dates to make it parsable by JS.
 *
 * @param dateString
 */
exports.parseISO8601String = function(dateString) {
  if (typeof dateString !== "string") {
    return new Date(NaN);
  }
  // attempt to parse as ISO8601 with inserted separators
  // yyyyMMddTHHmmssZ
  //     ^ ^    ^ ^
  const chars = [...dateString];
  chars.splice(13, 0, ":");
  chars.splice(11, 0, ":");
  chars.splice(6, 0, "-");
  chars.splice(4, 0, "-");
  return new Date(chars.join(""));
};

/**
 * Attempts to parse a dateString as a regular JS Date before falling back to
 * AWS's "ISO8601 Long Format" date.
 *
 * @param dateString
 */
exports.parseDate = function(dateString) {
  let date = new Date(dateString);
  if (isNaN(date)) {
    date = exports.parseISO8601String(dateString);
  }
  return date;
};

/**
 * Like Date.prototype.toISOString(), but without separators and milliseconds.
 *
 * @param date
 */
exports.toISO8601String = function(date) {
  return new Date(date).toISOString().replace(/[-:]|\.\d+/g, "");
};
