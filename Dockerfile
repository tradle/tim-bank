FROM mhart/alpine-node:4.2.4

RUN apk --update add git

# use changes to package.json to force Docker not to use the cache
# when we change our application's nodejs dependencies:

RUN mkdir -p /opt/app
WORKDIR /opt/app

ADD package.json npm-shrinkwrap.json /opt/app/
RUN npm config set registry https://registry.npmjs.org/
RUN cd /opt/app && npm install

# From here we load our application's code in, therefore the previous docker
# "layer" thats been cached will be used if possible

ADD . /opt/app

# put before npm install, to avoid installing devDependencies
# after leveldown prebuild script stops failing
# ENV NODE_ENV production

CMD ["sh", "run.sh"]
