FROM ubuntu:20.04
RUN apt-get update \
&& apt-get install -y --no-install-recommends wget gettext-base ca-certificates \
&& rm -rf /var/lib/apt/lists/*
ARG S3TEST_REVISION=master
WORKDIR /opt/s3tests
RUN wget https://github.com/ceph/s3-tests/archive/${S3TEST_REVISION}.tar.gz -O /tmp/s3tests.tar.gz \
&& tar xvzf /tmp/s3tests.tar.gz --strip 1 \
&& rm /tmp/s3tests.tar.gz
# local patch to enable container
RUN sed -i 's/sudo apt-get/apt-get/' ./bootstrap \
&& apt-get update \
&& DEBIAN_FRONTEND=noninteractive  ./bootstrap \
&& rm -rf /var/lib/apt/lists/*
COPY ./s3tests.conf.template /etc/s3tests.conf.template
ENV S3TEST_CONF=/etc/s3tests.conf
ENV S3TEST_HOST=localhost
ENV S3TEST_MAIN_USERID=123456789000
ENV S3TEST_MAIN_ACCESS_KEY=S3RVER
ENV S3TEST_MAIN_SECRET_KEY=S3RVER
ENV S3TEST_ALT_USERID=123456789000
ENV S3TEST_ALT_ACCESS_KEY=S3RVER
ENV S3TEST_ALT_SECRET_KEY=S3RVER
ENV S3TEST_TENANT_USERID=123456789000
ENV S3TEST_TENANT_ACCESS_KEY=S3RVER
ENV S3TEST_TENANT_SECRET_KEY=S3RVER
COPY ./docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD ["./virtualenv/bin/nosetests"]
