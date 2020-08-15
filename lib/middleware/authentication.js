'use strict';

const { createHmac, createHash } = require('crypto');
const { mapKeys, pickBy } = require('lodash');

const AWSAccount = require('../models/account');
const S3Error = require('../models/error');
const { RESPONSE_HEADERS } = require('./response-header-override');
const {
  encodeURIComponentRFC3986,
  parseDate,
  parseISO8601String,
} = require('../utils');

const SUBRESOURCES = {
  acl: 1,
  accelerate: 1,
  analytics: 1,
  cors: 1,
  lifecycle: 1,
  delete: 1,
  inventory: 1,
  location: 1,
  logging: 1,
  metrics: 1,
  notification: 1,
  partNumber: 1,
  policy: 1,
  requestPayment: 1,
  replication: 1,
  restore: 1,
  tagging: 1,
  torrent: 1,
  uploadId: 1,
  uploads: 1,
  versionId: 1,
  versioning: 1,
  versions: 1,
  website: 1,
};

/**
 * Middleware that verifies signed HTTP requests
 *
 * This also processes request and response headers specified via query params. Currently only S3
 * (V2) signatures are fully supported. V4 signatures have incomplete support.
 *
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/dev/RESTAuthentication.html}
 */
module.exports = () =>
  async function authentication(ctx, next) {
    if (ctx.state.website) {
      // skip for static website requests
      return next();
    }

    if (ctx.method === 'OPTIONS') {
      // skip for CORS OPTION requests
      return next();
    }

    const amzQueryHeaders = pickBy(
      mapKeys(ctx.query, (value, key) => key.toLowerCase()),
      (value, key) => key.startsWith('x-amz-'),
    );
    // x-amz-* values specified in query params take precedence over those in the headers
    Object.assign(ctx.headers, amzQueryHeaders);

    const mechanisms = {
      header: 'authorization' in ctx.headers,
      queryV2: 'Signature' in ctx.query,
      queryV4: 'X-Amz-Algorithm' in ctx.query,
    };

    const mechanismCount = Object.values(mechanisms).filter(Boolean).length;
    if (mechanismCount === 0) {
      return next();
    }
    if (mechanismCount !== 1) {
      throw new S3Error(
        'InvalidArgument',
        'Only one auth mechanism allowed; only the X-Amz-Algorithm query ' +
          'parameter, Signature query string parameter or the Authorization ' +
          'header should be specified',
        {
          ArgumentName: 'Authorization',
          ArgumentValue: ctx.get('Authorization'),
        },
      );
    }

    let canonicalizedResource = ctx.mountPath || '';
    if (ctx.params.bucket) {
      // the following behavior is derived from the behavior of the JS aws-sdk
      if (ctx.state.vhost) {
        canonicalizedResource = '/' + ctx.params.bucket + canonicalizedResource;
      } else {
        canonicalizedResource += '/' + ctx.params.bucket;
      }
      if (ctx.params.key) {
        canonicalizedResource += '/' + ctx.params.key;
      }
    } else {
      canonicalizedResource += '/';
    }
    canonicalizedResource = canonicalizedResource
      .split('/')
      .map(encodeURIComponentRFC3986)
      .join('/');

    const canonicalizedQueryString = Object.entries(ctx.query)
      .filter(
        ([param]) =>
          SUBRESOURCES[param] ||
          RESPONSE_HEADERS[param] ||
          (mechanisms.queryV4 &&
            param.startsWith('X-Amz-') &&
            param !== 'X-Amz-Signature'),
      )
      .map(
        ([param, value]) =>
          mechanisms.queryV2
            ? [param, value].join('=') // v2 signing doesn't encode values in the signature calculation
            : encodeURIComponent(param) + '=' + encodeURIComponent(value), // v4 signing requires the = be present even when there's no value
      )
      .sort()
      .join('&');

    const canonicalizedAmzHeaders = Object.keys(ctx.headers)
      .filter(headerName => headerName.startsWith('x-amz-'))
      .sort()
      .map(
        headerName =>
          `${headerName}:${ctx.get(headerName).replace(/ +/g, ' ')}`,
      );

    const canonicalRequest = {
      method:
        ctx.method === 'OPTIONS'
          ? ctx.get('Access-Control-Request-Method')
          : ctx.method,
      contentMD5: ctx.get('Content-MD5'),
      contentType: ctx.get('Content-Type'),
      headers: ctx.headers,
      timestamp: undefined,
      uri: canonicalizedResource,
      querystring: canonicalizedQueryString,
      amzHeaders: canonicalizedAmzHeaders,
    };

    // begin parsing for each part of the signature algorithm and the rest of the canonical request
    let parseResult;
    if (mechanisms.header) {
      parseResult = parseHeader(ctx.headers);
    } else if (mechanisms.queryV2) {
      parseResult = parseQueryV2(ctx.query, ctx.headers);
    } else if (mechanisms.queryV4) {
      parseResult = parseQueryV4(ctx.query, ctx.headers);
    }

    const { signature, signatureProvided } = parseResult;

    if (signature.version === 2) {
      // S3 signing uses expiration time as timestamp
      canonicalRequest.timestamp = parseResult.expires;
    } else if (signature.version === 4) {
      canonicalRequest.timestamp = parseResult.timestamp;
    }

    let stringToSign;
    const account = AWSAccount.registry.get(signature.accessKeyId);
    if (!account) {
      throw new S3Error(
        'InvalidAccessKeyId',
        'The AWS Access Key Id you provided does not exist in our records.',
        { AWSAccessKeyId: signature.accessKeyId },
      );
    }

    if (signature.version === 2) {
      stringToSign = getStringToSignV2(canonicalRequest);

      const signingKey = account.accessKeys.get(signature.accessKeyId);
      const calculatedSignature = calculateSignatureV2(
        stringToSign,
        signingKey,
        signature.algorithm,
      );
      if (signatureProvided === calculatedSignature) {
        ctx.state.account = account;
      }
    } else if (signature.version === 4) {
      stringToSign = getStringToSignV4(canonicalRequest, signature);

      const secretKey = account.accessKeys.get(signature.accessKeyId);
      const calculatedSignature = calculateSignatureV4(
        stringToSign,
        secretKey,
        signature.credential.date,
        signature.credential.region,
        signature.credential.service,
      );
      if (signatureProvided === calculatedSignature) {
        ctx.state.account = account;
      }
    }

    if (!ctx.state.account) {
      if (ctx.app.allowMismatchedSignatures) {
        ctx.state.account = account;
      } else {
        throw new S3Error(
          'SignatureDoesNotMatch',
          'The request signature we calculated does not match the signature ' +
            'you provided. Check your key and signing method.',
          {
            AWSAccessKeyId: signature.accessKeyId,
            StringToSign: stringToSign,
            StringToSignBytes: Buffer.from(stringToSign)
              .toString('hex')
              .match(/../g)
              .join(' '),
          },
        );
      }
    }

    return next();
  };

function parseHeader(headers) {
  const signature = {
    version: undefined,
    algorithm: undefined,
    accessKeyId: undefined,
  };
  let signatureProvided;
  const timestamp = headers['x-amz-date'] || headers.date;

  const [algorithm, ...components] = headers.authorization.split(' ');
  switch (algorithm.toUpperCase()) {
    case 'AWS':
      signature.version = 2;
      signature.algorithm = 'sha1';
      break;
    case 'AWS4-HMAC-SHA256':
      signature.version = 4;
      signature.algorithm = 'sha256';
      break;
    default:
      throw new S3Error('InvalidArgument', 'Unsupported Authorization Type', {
        ArgumentName: 'Authorization',
        ArgumentValue: headers.authorization,
      });
  }

  if (signature.version === 2) {
    if (components.length !== 1) {
      throw new S3Error(
        'InvalidArgument',
        "Authorization header is invalid -- one and only one ' ' (space) required",
        {
          ArgumentName: 'Authorization',
          ArgumentValue: headers.authorization,
        },
      );
    }

    const match = /([^:]*):([^:]+)/.exec(components[0]);
    if (!match) {
      throw new S3Error(
        'InvalidArgument',
        'AWS authorization header is invalid.  Expected AwsAccessKeyId:signature',
        {
          ArgumentName: 'Authorization',
          ArgumentValue: headers.authorization,
        },
      );
    }
    signature.accessKeyId = match[1];
    signatureProvided = match[2];
  } else if (signature.version === 4) {
    if (!('x-amz-content-sha256' in headers)) {
      throw new S3Error(
        'InvalidRequest',
        'Missing required header for this request: x-amz-content-sha256',
      );
    }
    if (
      !headers['x-amz-content-sha256'].match(
        /UNSIGNED-PAYLOAD|STREAMING-AWS4-HMAC-SHA256-PAYLOAD|[0-9A-Fa-f]{64}/,
      )
    ) {
      throw new S3Error(
        'InvalidArgument',
        'x-amz-content-sha256 must be UNSIGNED-PAYLOAD, ' +
          'STREAMING-AWS4-HMAC-SHA256-PAYLOAD, or a valid sha256 value.',
        {
          ArgumentName: 'x-amz-content-sha256',
          ArgumentValue: headers['x-amz-content-sha256'],
        },
      );
    }

    // skip payload verification

    const componentMap = new Map(
      components
        .join('')
        .split(',')
        .map(component => {
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
    }

    // skip verification of each authorization header component

    const [accessKeyId, date, region, service, termination] = componentMap
      .get('Credential')
      .split('/');

    signature.accessKeyId = accessKeyId;
    signature.credential = { date, region, service, termination };
    signature.signedHeaders = componentMap.get('SignedHeaders').split(';');

    signatureProvided = componentMap.get('Signature');
  }

  const serverTime = new Date();
  const requestTime = parseDate(timestamp);
  if (isNaN(requestTime)) {
    throw new S3Error(
      'AccessDenied',
      'AWS authentication requires a valid Date or x-amz-date header',
    );
  }

  if (Math.abs(serverTime - requestTime) > 900000) {
    // 15 minutes
    throw new S3Error(
      'RequestTimeTooSkewed',
      'The difference between the request time and the current time is too large.',
      {
        RequestTime: timestamp,
        ServerTime: serverTime.toISOString().replace(/\.\d+/, ''),
      },
    );
  }
  return {
    signature,
    signatureProvided,
    timestamp,
  };
}

function parseQueryV2(query) {
  // authentication param names are case-sensitive
  if (!('Expires' in query) || !('AWSAccessKeyId' in query)) {
    throw new S3Error(
      'AccessDenied',
      'Query-string authentication requires the Signature, Expires and ' +
        'AWSAccessKeyId parameters',
    );
  }

  const signature = {
    version: 2,
    algorithm: 'sha1',
    accessKeyId: query.AWSAccessKeyId,
  };
  const signatureProvided = query.Signature;

  const serverTime = new Date();
  const expiresTime = new Date(Number(query.Expires) * 1000);
  if (isNaN(expiresTime)) {
    throw new S3Error(
      'AccessDenied',
      `Invalid date (should be seconds since epoch): ${query.Expires}`,
    );
  }

  if (serverTime > expiresTime) {
    throw new S3Error('AccessDenied', 'Request has expired', {
      Expires: expiresTime.toISOString().replace(/\.\d+/, ''),
      ServerTime: serverTime.toISOString().replace(/\.\d+/, ''),
    });
  }

  return {
    signature,
    signatureProvided,
    expires: Number(query.Expires),
  };
}

function parseQueryV4(query) {
  // query param values are case-sensitive
  if (query['X-Amz-Algorithm'] !== 'AWS4-HMAC-SHA256') {
    throw new S3Error(
      'AuthorizationQueryParametersError',
      'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"',
    );
  }

  const signature = {
    version: 4,
    algorithm: 'sha256',
    accessKeyId: undefined,
  };

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
  const [accessKeyId, date, region, service, termination] = query[
    'X-Amz-Credential'
  ].split('/');

  signature.accessKeyId = accessKeyId;
  signature.credential = { date, region, service, termination };
  signature.signedHeaders = query['X-Amz-SignedHeaders'].split(';');

  const signatureProvided = query['X-Amz-Signature'];

  const timestamp = query['X-Amz-Date'];

  const requestTime = parseISO8601String(timestamp);
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

  return {
    signature,
    signatureProvided,
    timestamp,
  };
}

/**
 * Generates a string to be signed for signature version 2.
 *
 * @param {*} canonicalRequest
 */
function getStringToSignV2(canonicalRequest) {
  const queryString = canonicalRequest.querystring.replace(/=(&|$)/g, ''); // remove trailing = for empty params

  return [
    canonicalRequest.method,
    canonicalRequest.contentMD5,
    canonicalRequest.contentType,
    canonicalRequest.timestamp,
    ...canonicalRequest.amzHeaders,
    queryString
      ? `${canonicalRequest.uri}?${queryString}`
      : canonicalRequest.uri,
  ].join('\n');
}

/**
 * Generates a string to be signed for signature version 4.
 *
 * @param {*} canonicalRequest
 * @param {*} signature
 */
function getStringToSignV4(canonicalRequest, { credential, signedHeaders }) {
  const canonicalHeaders = signedHeaders
    .map(header => `${header}:${canonicalRequest.headers[header]}\n`)
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
    createHash('sha256')
      .update(canonicalRequestString)
      .digest('hex'),
  ].join('\n');
}

/**
 * Performs the calculation of an authentication code for a string using the specified key and
 * algorithm.
 *
 * @param {String} stringToSign the string representation of a canonical request
 * @param {String} signingKey a secret access key
 * @param {String} algorithm should be one of "sha1" or "sha256"
 */
function calculateSignatureV2(stringToSign, signingKey, algorithm) {
  const signature = createHmac(algorithm, signingKey);
  signature.update(stringToSign, 'utf8');
  return signature.digest('base64');
}

/**
 * Performs the calculation of an authentication code for a string using the specified key and
 * various components required by v4.
 *
 * @param {String} stringToSign the string representation of a canonical request
 * @param {String} secretKey a secret access key
 * @param {String} date received from the credential header
 * @param {String} region received From the credential header
 * @param {String} service received From the credential header
 */
function calculateSignatureV4(stringToSign, secretKey, date, region, service) {
  const dateKey = createHmac('sha256', 'AWS4' + secretKey)
    .update(date)
    .digest();

  const regionKey = createHmac('sha256', dateKey)
    .update(region)
    .digest();

  const serviceKey = createHmac('sha256', regionKey)
    .update(service)
    .digest();

  const signingKey = createHmac('sha256', serviceKey)
    .update('aws4_request')
    .digest();

  return createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
}
