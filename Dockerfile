FROM ubuntu:latest
MAINTAINER SITE

# 80 = HTTP, 443 = HTTPS, 3000 = SITE server, 35729 = livereload, 8080 = node-inspector
EXPOSE 80 443 3000 35729 8080

# Set staging environment as default
ENV NODE_ENV development

# Install Utilities
RUN apt-get update -q  \
 && apt-get install -yqq \
 curl \
 git \
 ssh \
 gcc \
 make \
 build-essential \
 libkrb5-dev \
 libpng-dev \
 sudo \
 apt-utils \
 vim \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Install nodejs
RUN curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
RUN sudo apt-get install -yq nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Install SITE Prerequisites
RUN npm install --quiet -g gulp bower yo mocha karma-cli pm2

RUN mkdir -p /opt/site/public/lib
WORKDIR /opt/site

# Copies the local package.json file to the container
# and utilities docker container cache to not needing to rebuild
# and install node_modules/ everytime we build the docker, but only
# when the local package.json file changes.
# Install npm packages
COPY package.json /opt/site/package.json
RUN npm install --quiet

# Install bower packages
COPY . /opt/site

ENV NODE_ENV production
CMD gulp prod
