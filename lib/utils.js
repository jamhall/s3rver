'use strict';

const crypto = require('crypto');
const xmlParser = require('fast-xml-parser');
const fs = require('fs-extra');
const he = require('he');
const path = require('path');
const { PassThrough, Transform } = require('stream');

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

const CRLF = Buffer.from('\r\n');

class AwsChunkedTransform extends Transform {
  constructor(expectedContentLength) {
    super();

    if (Number.isNaN(expectedContentLength)) {
      throw new S3Error(
        'MissingContentLength',
        'You must provide the Content-Length HTTP header.',
      );
    }

    this.chunkDecoderState = {
      num: 0,
      size: NaN,
      header: null,
      hash: null,
      bytesRemaining: 0,
      buf: Buffer.alloc(0),
      decodedContentLength: 0,
      expectedContentLength,
    };
  }

  endsWithCr(buf) {
    return buf[buf.length - 1] === CRLF[0];
  }

  startsWithLf(buf, position = 0) {
    return buf[position] === CRLF[1];
  }

  finalizeChunkHeader() {
    const [sizeHex, ...params] = this.chunkDecoderState.buf
      .slice(0, -CRLF.length)
      .toString()
      .split(';');
    const nextChunkSize = parseInt(sizeHex, 16);

    // The chunk number AWS reports seem to be off by one, likely because the check for the small
    // chunk sizes doesn't happen until next chunk's header is parsed and the counter is incremented
    this.chunkDecoderState.num++;
    if (nextChunkSize > 0) {
      if (this.chunkDecoderState.size < 8192) {
        throw new S3Error(
          'InvalidChunkSizeError',
          'Only the last chunk is allowed to have a size less than 8192 bytes',
          {
            Chunk: this.chunkDecoderState.num,
            BadChunkSize: this.chunkDecoderState.size,
          },
        );
      }
    } else if (
      !Number.isInteger(nextChunkSize) ||
      this.chunkDecoderState.size === 0
    ) {
      // chunks with noninteger sizes or additional chunks sent after an empty chunk should
      // trigger an IncompleteBody error
      throw new S3Error(
        'IncompleteBody',
        'The request body terminated unexpectedly',
      );
    }
    this.chunkDecoderState.size = this.chunkDecoderState.bytesRemaining = nextChunkSize;
    this.chunkDecoderState.hash = crypto.createHash('sha256');
    this.chunkDecoderState.header = new Map(
      params.map((entry) => entry.split('=')),
    );

    // AWS's chunk header parsing seems to naively assume that only one param is ever
    // specified and breaks in strange ways depending on if additional params are appended or
    // prepended. The behavior below matches S3 most of the time.
    if (
      !this.chunkDecoderState.header.has('chunk-signature') ||
      this.chunkDecoderState.header.size > 1
    ) {
      throw new S3Error(
        'IncompleteBody',
        'The request body terminated unexpectedly',
      );
    }

    this.chunkDecoderState.buf = Buffer.alloc(0);
  }

  finalizeChunk() {
    if (!CRLF.equals(this.chunkDecoderState.buf)) {
      throw new S3Error(
        'IncompleteBody',
        'The request body terminated unexpectedly',
      );
    }
    this.chunkDecoderState.decodedContentLength += this.chunkDecoderState.size;
    this.chunkDecoderState.buf = Buffer.alloc(0);
    this.chunkDecoderState.header = null;
  }

  /**
   * Consumes bytes from a chunk until a CRLF sequence is discovered
   *
   * @param {Buffer} chunk
   * @param {number} position
   * @returns the number of bytes read from the chunk including the CRLF if one was discovered
   */
  consumeUntilCrlf(chunk, position = 0) {
    let crlfIdx;
    if (
      this.endsWithCr(this.chunkDecoderState.buf) &&
      this.startsWithLf(chunk, position)
    ) {
      crlfIdx = -1;
    } else {
      crlfIdx = chunk.indexOf(CRLF, position);
      if (crlfIdx === -1) {
        crlfIdx = chunk.length;
      }
    }
    this.chunkDecoderState.buf = Buffer.concat([
      this.chunkDecoderState.buf,
      chunk.slice(position, crlfIdx + CRLF.length),
    ]);
    return Math.min(crlfIdx + CRLF.length, chunk.length) - position;
  }

  /**
   * Consumes bytes from a chunk up to the expected chunk length
   *
   * @param {Buffer} chunk
   * @param {number} position
   * @returns the number of bytes read from the chunk
   */
  consumePayload(chunk, position = 0) {
    const payload = chunk.slice(
      position,
      position + this.chunkDecoderState.bytesRemaining,
    );
    this.chunkDecoderState.buf = Buffer.concat([
      this.chunkDecoderState.buf,
      payload,
    ]);
    this.chunkDecoderState.hash.update(payload);
    this.chunkDecoderState.bytesRemaining -= payload.length;
    return payload.length;
  }

  _transform(chunk, encoding, callback) {
    if (!this.readableFlowing) {
      // don't transform anything if nothing is reading the data yet
      this.once('resume', () => this._transform(chunk, encoding, callback));
      return;
    }
    try {
      let payload = Buffer.alloc(0);
      let i = 0;
      do {
        if (this.chunkDecoderState.header) {
          // header has been parsed, start reading bytes
          if (this.chunkDecoderState.bytesRemaining) {
            i += this.consumePayload(chunk, i);
            payload = Buffer.concat([payload, this.chunkDecoderState.buf]);
            this.chunkDecoderState.buf = Buffer.alloc(0);
          } else {
            if (this.chunkDecoderState.hash) {
              // TODO: validate signatures before verifying CRLF
              // const hashDigest = this.chunkDecoderState.hash.digest();
              this.chunkDecoderState.hash = null;
            }
            i += this.consumeUntilCrlf(chunk, i);
            if (this.chunkDecoderState.buf.length >= CRLF.length) {
              this.finalizeChunk();
            }
          }
        } else {
          i += this.consumeUntilCrlf(chunk, i);
          if (CRLF.equals(this.chunkDecoderState.buf.slice(-CRLF.length))) {
            this.finalizeChunkHeader();
          }
        }
      } while (i < chunk.length);
      callback(null, payload);
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    const {
      size,
      decodedContentLength,
      expectedContentLength,
    } = this.chunkDecoderState;
    // the final chunk processed should have zero length
    if (size !== 0) {
      callback(
        new S3Error(
          'IncompleteBody',
          'The request body terminated unexpectedly',
        ),
      );
    } else if (decodedContentLength !== expectedContentLength) {
      callback(
        new S3Error(
          'IncompleteBody',
          'You did not provide the number of bytes specified by the Content-Length HTTP header',
        ),
      );
    } else {
      callback(null);
    }
  }
}

/**
 * Transforms a request body stream sent using aws-chunked encoding.
 *
 * Content hash verification is unimplemented.
 *
 * @param {Koa.Context} ctx
 */
exports.aws4SignatureBodyParser = function (ctx) {
  ctx.request.body =
    ctx.header['x-amz-content-sha256'] === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
      ? ctx.req.pipe(
          new AwsChunkedTransform(
            parseInt(ctx.get('X-Amz-Decoded-Content-Length')),
          ),
        )
      : ctx.req;
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

/**
 * Basic reimplementation of events.once available in Node 10+
 */
exports.once = (emitter, event) => {
  return new Promise((resolve, reject) => {
    emitter.once('error', reject);
    emitter.once(event, (...args) => resolve(args));
  });
};
