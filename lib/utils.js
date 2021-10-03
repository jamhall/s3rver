'use strict';

const crypto = require('crypto');
const xmlParser = require('fast-xml-parser');
const fs = require('fs');
const he = require('he');
const path = require('path');
const { PassThrough } = require('stream');

const S3Error = require('./models/error');

exports.walk = function* walk(dir, recurseFilter) {
  for (const filename of fs.readdirSync(dir)) {
    const filePath = path.posix.join(dir, filename);
    const stats = fs.statSync(filePath);
    if (!stats.isDirectory()) {
      yield filePath;
    } else if (!recurseFilter || recurseFilter(filePath)) {
      yield* walk(filePath, recurseFilter);
    }
  }
};

exports.capitalizeHeader = function (header) {
  const exceptions = {
    'content-md5': 'Content-MD5',
    dnt: 'DNT',
    etag: 'ETag',
    'last-event-id': 'Last-Event-ID',
    tcn: 'TCN',
    te: 'TE',
    'www-authenticate': 'WWW-Authenticate',
    'x-dnsprefetch-control': 'X-DNSPrefetch-Control',
  };

  header = header.toLowerCase();

  if (header in exceptions) return exceptions[header];
  if (header.startsWith('x-amz-')) return header;

  // Capitalize the first letter of each word
  return header
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('-');
};

exports.concatStreams = function (streams) {
  const passThrough = new PassThrough();
  streams = [...streams];
  const pipeNext = (stream) => {
    if (!stream) return passThrough.end();

    stream.once('end', () => pipeNext(streams.shift()));
    stream.pipe(passThrough, { end: false });
  };
  pipeNext(streams.shift());
  return passThrough;
};

/**
 * URI-encodes a string according to RFC 3986. This is what AWS uses for
 * S3 resource URIs.
 *
 * @param {string} string
 */
exports.encodeURIComponentRFC3986 = function (string) {
  return encodeURIComponent(string).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
};

exports.getXmlRootTag = function (xml) {
  const traversal = xmlParser.getTraversalObj(xml.toString());
  const [[root]] = Object.values(traversal.child);
  return root && root.tagname;
};

exports.randomBase64String = function (length) {
  return crypto
    .randomBytes(Math.ceil((length * 3) / 4))
    .toString('base64')
    .slice(0, length);
};

exports.randomHexString = function (length) {
  return crypto
    .randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
};

/**
 * Inserts separators into AWS ISO8601 formatted-dates to make it parsable by JS.
 *
 * @param dateString
 */
exports.parseISO8601String = function (dateString) {
  if (typeof dateString !== 'string') {
    return new Date(NaN);
  }
  // attempt to parse as ISO8601 with inserted separators
  // yyyyMMddTHHmmssZ
  //     ^ ^    ^ ^
  const chars = [...dateString];
  chars.splice(13, 0, ':');
  chars.splice(11, 0, ':');
  chars.splice(6, 0, '-');
  chars.splice(4, 0, '-');
  return new Date(chars.join(''));
};

/**
 * Attempts to parse a dateString as a regular JS Date before falling back to
 * AWS's "ISO8601 Long Format" date.
 *
 * @param dateString
 */
exports.parseDate = function (dateString) {
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
exports.toISO8601String = function (date) {
  return new Date(date).toISOString().replace(/[-:]|\.\d+/g, '');
};

/**
 * Reads a request body to as parsed XML.
 *
 * @param {Koa.Context} ctx
 */
exports.xmlBodyParser = async function xmlBodyParser(ctx) {
  const { req } = ctx;
  const xmlString = await new Promise((resolve, reject) => {
    let payload = '';
    req.on('data', (data) => (payload += data.toString('utf8')));
    req.on('end', () => resolve(payload));
    req.on('error', reject);
  });
  if (xmlParser.validate(xmlString) !== true) {
    throw new S3Error(
      'MalformedXML',
      'The XML you provided was not well-formed or did not validate against ' +
        'our published schema.',
    );
  }
  ctx.request.body = xmlParser.parse(xmlString, {
    tagValueProcessor: (a) => he.decode(a),
  });
};

/**
 * Reads a request body stream to a string.
 *
 * @param {Koa.Context} ctx
 */
exports.utf8BodyParser = async function (ctx) {
  const { req } = ctx;
  ctx.request.body = await new Promise((resolve, reject) => {
    let payload = '';
    req.on('data', (data) => (payload += data.toString('utf8')));
    req.on('end', () => resolve(payload));
    req.on('error', reject);
  });
};

exports.ensureDir = async function (dirPath) {
  const options = { recursive: true, mode: 0o0755 };
  if (process.platform === 'win32') {
    delete options.mode;
  }
  await fs.promises.mkdir(dirPath, options);
};
