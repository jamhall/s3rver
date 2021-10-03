'use strict';

const { Transform } = require('stream');
const { createHash, createHmac } = require('crypto');

const S3Error = require('../models/error');
const { parseISO8601String } = require('../utils');

const CRLF = Buffer.from('\r\n');

exports.parseHeader = function (headers) {
  if (!('x-amz-content-sha256' in headers)) {
    throw new S3Error(
      'InvalidRequest',
      'Missing required header for this request: x-amz-content-sha256',
    );
  }
  if (
    !headers['x-amz-content-sha256'].match(
      /^(UNSIGNED-PAYLOAD|STREAMING-AWS4-HMAC-SHA256-PAYLOAD|[0-9A-Fa-f]{64})$/,
    )
  ) {
    throw new S3Error(
      'InvalidArgument',
      'x-amz-content-sha256 must be UNSIGNED-PAYLOAD, STREAMING-AWS4-HMAC-SHA256-PAYLOAD, or a valid sha256 value.',
      {
        ArgumentName: 'x-amz-content-sha256',
        ArgumentValue: headers['x-amz-content-sha256'],
      },
    );
  }

  const componentMap = new Map(
    headers.authorization
      .split(' ')
      .slice(1)
      .join('')
      .split(',')
      .map((component) => {
        const [key, ...value] = component.split('=');
        return [key, value.join('=')];
      }),
  );

  if (componentMap.size !== 3) {
    throw new S3Error(
      'AuthorizationHeaderMalformed',
      'The authorization header is malformed; the authorization header ' +
        'requires three components: Credential, SignedHeaders, and ' +
        'Signature.',
    );
  }

  for (const componentName of ['Credential', 'SignedHeaders', 'Signature']) {
    if (!componentMap.has(componentName)) {
      throw new S3Error(
        'AuthorizationHeaderMalformed',
        `The authorization header is malformed; missing ${componentName}.`,
      );
    }
    // skip verification of each authorization header component
  }

  const [accessKeyId, date, region, service, termination] = componentMap
    .get('Credential')
    .split('/');

  return {
    accessKeyId,
    credential: { date, region, service, termination },
    signedHeaders: componentMap.get('SignedHeaders').split(';'),
    signatureProvided: componentMap.get('Signature'),
  };
};

exports.parseQuery = function (query) {
  // query param values are case-sensitive
  if (query['X-Amz-Algorithm'] !== 'AWS4-HMAC-SHA256') {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"',
    );
  }

  if (
    !('X-Amz-Credential' in query) ||
    !('X-Amz-Signature' in query) ||
    !('X-Amz-Date' in query) ||
    !('X-Amz-SignedHeaders' in query) ||
    !('X-Amz-Expires' in query)
  ) {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'Query-string authentication version 4 requires the ' +
        'X-Amz-Algorithm, X-Amz-Credential, X-Amz-Signature, X-Amz-Date, ' +
        'X-Amz-SignedHeaders, and X-Amz-Expires parameters.',
    );
  }
  const [accessKeyId, date, region, service, termination] =
    query['X-Amz-Credential'].split('/');

  const request = {
    signature: {
      version: 4,
      algorithm: 'sha256',
      encoding: 'hex',
    },
    accessKeyId,
    credential: { date, region, service, termination },
    time: query['X-Amz-Date'],
    signedHeaders: query['X-Amz-SignedHeaders'].split(';'),
    signatureProvided: query['X-Amz-Signature'],
  };

  const requestTime = parseISO8601String(request.time);
  if (isNaN(requestTime)) {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      "X-Amz-Date must be in the ISO8601 Long Format \"yyyyMMdd'T'HHmmss'Z'\"",
    );
  }

  const expires = Number(query['X-Amz-Expires']);
  if (isNaN(expires))
    if (expires < 0) {
      throw new S3Error(
        'AuthorizationQueryParametersError',
        'X-Amz-Expires must be non-negative',
      );
    }
  if (expires > 604800) {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'X-Amz-Expires must be less than a week (in seconds); that is, the ' +
        'given X-Amz-Expires must be less than 604800 seconds',
    );
  }

  const serverTime = new Date();
  // NOTE: S3 doesn't care about time skew for presigned requests
  const expiresTime = new Date(Number(requestTime) + expires * 1000);

  if (serverTime > expiresTime) {
    throw new S3Error('AccessDenied', 'Request has expired', {
      'X-Amz-Expires': query['X-Amz-Expires'],
      Expires: expiresTime.toISOString().replace(/\.\d+/, ''),
      ServerTime: serverTime.toISOString().replace(/\.\d+/, ''),
    });
  }

  return request;
};

/**
 * Generates a string to be signed for signature version 4.
 *
 * @param {*} canonicalRequest
 * @param {*} signature
 */
exports.getStringToSign = function (
  canonicalRequest,
  { credential, signedHeaders },
) {
  const canonicalHeaders = signedHeaders
    .map((header) => `${header}:${canonicalRequest.headers[header]}\n`)
    .join('');

  const contentHash =
    canonicalRequest.headers['x-amz-content-sha256'] || 'UNSIGNED-PAYLOAD';

  const canonicalRequestString = [
    canonicalRequest.method,
    canonicalRequest.uri,
    canonicalRequest.querystring,
    canonicalHeaders,
    signedHeaders.join(';'),
    contentHash,
  ].join('\n');

  return [
    'AWS4-HMAC-SHA256',
    canonicalRequest.timestamp,
    [
      credential.date,
      credential.region,
      credential.service,
      credential.termination,
    ].join('/'),
    createHash('sha256').update(canonicalRequestString).digest('hex'),
  ].join('\n');
};

/**
 * Performs the calculation of an authentication code for a string using the specified key and
 * various components required by v4.
 *
 * @param {String} secretKey a secret access key
 * @param {String} date received from the credential header
 * @param {String} region received From the credential header
 * @param {String} service received From the credential header
 */
exports.getSigningKey = function (secretKey, date, region, service) {
  const dateKey = createHmac('sha256', 'AWS4' + secretKey)
    .update(date)
    .digest();
  const regionKey = createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update(service).digest();
  const signingKey = createHmac('sha256', serviceKey)
    .update('aws4_request')
    .digest();

  return signingKey;
};

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
    this.chunkDecoderState.size = this.chunkDecoderState.bytesRemaining =
      nextChunkSize;
    this.chunkDecoderState.hash = createHash('sha256');
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
    const { size, decodedContentLength, expectedContentLength } =
      this.chunkDecoderState;
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
