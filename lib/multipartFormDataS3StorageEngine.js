/**
 * A multer storage engine that uses the  s3rver file-store to save the upload
 */
function S3Storage(opts) {
  this.fileStore = opts.fileStore;
}

S3Storage.prototype._handleFile = function(req, file, cb) {
  this.fileStore.postObject({ name: req.body.bucket }, req.body.key, req, file, cb);
}

S3Storage.prototype._removeFile = function() {
  throw new Error("Removal of file by POST is not supported");
}

module.exports = function(opts) {
  return new S3Storage(opts)
}
