'use strict';
const Assert = require('assert');
const Fs = require('fs');
const Path = require('path');
const Barrier = require('cb-barrier');
const Lab = require('@hapi/lab');
const Grpc = require('@grpc/grpc-js');
const { Server, ServerCredentials } = require('../lib');
const { loadProtoFile } = require('./common');

// Test shortcuts
const lab = exports.lab = Lab.script();
const { describe, it, before, after, beforeEach, afterEach } = lab;


const clientInsecureCreds = Grpc.credentials.createInsecure();
const serverInsecureCreds = ServerCredentials.createInsecure();


describe('Server', () => {
  describe('constructor', () => {
    it('should work with no arguments', () => {
      Assert.doesNotThrow(() => {
        new Server(); // eslint-disable-line no-new
      });
    });

    it('should work with an empty object argument', () => {
      Assert.doesNotThrow(() => {
        new Server({}); // eslint-disable-line no-new
      });
    });

    it('should be an instance of Server', () => {
      const server = new Server();

      Assert(server instanceof Server);
    });
  });

  describe('bindAsync', () => {
    it('binds with insecure credentials', () => {
      const server = new Server();
      const barrier = new Barrier();

      server.bindAsync('localhost:0', serverInsecureCreds, (err, port) => {
        Assert.ifError(err);
        Assert(typeof port === 'number' && port > 0);
        server.tryShutdown(() => {
          barrier.pass();
        });
      });

      return barrier;
    });

    it('binds with secure credentials', () => {
      const server = new Server();
      const barrier = new Barrier();
      const ca = Fs.readFileSync(Path.join(__dirname, 'fixtures', 'ca.pem'));
      const key = Fs.readFileSync(Path.join(__dirname, 'fixtures', 'server1.key'));
      const cert = Fs.readFileSync(Path.join(__dirname, 'fixtures', 'server1.pem'));

      const creds = ServerCredentials.createSsl(ca,
        [{ private_key: key, cert_chain: cert }], true);

      server.bindAsync('localhost:0', creds, (err, port) => {
        Assert.ifError(err);
        Assert(typeof port === 'number' && port > 0);
        server.tryShutdown(() => {
          barrier.pass();
        });
      });

      return barrier;
    });

    it('throws if bind is called after the server is started', () => {
      const server = new Server();
      const barrier = new Barrier();

      server.bindAsync('localhost:0', serverInsecureCreds, (err, port) => {
        Assert.ifError(err);
        server.start();
        Assert.throws(() => {
          server.bindAsync('localhost:0', serverInsecureCreds, () => {});
        }, /server is already started/);
        barrier.pass();
      });

      return barrier;
    });

    it('throws on invalid inputs', () => {
      const server = new Server();

      Assert.throws(() => {
        server.bindAsync(null, serverInsecureCreds, () => {});
      }, /port must be a string/);

      Assert.throws(() => {
        server.bindAsync('localhost:0', null, () => {});
      }, /creds must be an object/);

      Assert.throws(() => {
        server.bindAsync('localhost:0', 'foo', () => {});
      }, /creds must be an object/);

      Assert.throws(() => {
        server.bindAsync('localhost:0', serverInsecureCreds, null);
      }, /callback must be a function/);
    });
  });

  describe('start', () => {
    let server;

    beforeEach(async () => {
      server = new Server();
      await server.bind(8000, ServerCredentials.createInsecure());
    });

    afterEach(() => {
      server.tryShutdown();
    });

    it('should start without error', () => {
      Assert.doesNotThrow(() => {
        server.start();
      });
    });

    it('should error if started twice', () => {
      server.start();
      Assert.throws(() => {
        server.start();
      }, /server is already started/);
    });

    it('should error if bind is called after the server starts', () => {
      server.start();
      Assert.rejects(async () => {
        await server.bind('localhost:0', serverInsecureCreds);
      }, /server is already started/);
    });
  });

  describe('Server.prototype.addService', () => {
    const mathProtoFile = Path.join(__dirname, 'proto', 'math.proto');
    const MathClient = loadProtoFile(mathProtoFile).math.Math;
    const mathServiceAttrs = MathClient.service;
    const dummyImpls = {
      div () {},
      divMany () {},
      fib () {},
      sum () {}
    };
    const altDummyImpls = {
      Div () {},
      DivMany () {},
      Fib () {},
      Sum () {}
    };
    let server;

    beforeEach(() => {
      server = new Server();
    });

    after(() => {
      server.tryShutdown();
    });

    it('Should succeed with a single service', () => {
      Assert.doesNotThrow(() => {
        server.addService(mathServiceAttrs, dummyImpls);
      });
    });

    it('Should fail with conflicting method names', () => {
      server.addService(mathServiceAttrs, dummyImpls);
      Assert.throws(() => {
        server.addService(mathServiceAttrs, dummyImpls);
      });
    });

    it('Should allow method names as originally written', () => {
      Assert.doesNotThrow(() => {
        server.addService(mathServiceAttrs, altDummyImpls);
      });
    });

    it('Should fail if the server has been started', async () => {
      await server.bind('localhost:0', serverInsecureCreds);
      server.start();
      Assert.throws(() => {
        server.addService(mathServiceAttrs, dummyImpls);
      }, /Can't add a service to a started server\./);
    });

    describe('Default handlers', () => {
      let client;

      beforeEach(async () => {
        server.addService(mathServiceAttrs, {});
        const port = await server.bind('localhost:0', serverInsecureCreds);
        client = new MathClient(`localhost:${port}`, clientInsecureCreds);
        server.start();
      });

      it('should respond to a unary call with UNIMPLEMENTED', () => {
        const barrier = new Barrier();

        client.div({ divisor: 4, dividend: 3 }, (error, response) => {
          Assert(error);
          Assert.strictEqual(error.code, Grpc.status.UNIMPLEMENTED);
          barrier.pass();
        });

        return barrier;
      });

      it('should respond to a client stream with UNIMPLEMENTED', () => {
        const barrier = new Barrier();
        const call = client.sum((error, respones) => {
          Assert(error);
          Assert.strictEqual(error.code, Grpc.status.UNIMPLEMENTED);
          barrier.pass();
        });

        call.end();
        return barrier;
      });

      it('should respond to a server stream with UNIMPLEMENTED', () => {
        const barrier = new Barrier();
        const call = client.fib({ limit: 5 });

        call.on('data', (value) => {
          Assert.fail('No messages expected');
        });

        call.on('error', (err) => {
          Assert(err);
          Assert.strictEqual(err.code, Grpc.status.UNIMPLEMENTED);
          barrier.pass();
        });

        return barrier;
      });

      it('should respond to a bidi call with UNIMPLEMENTED', () => {
        const barrier = new Barrier();
        const call = client.divMany();

        call.on('data', (value) => {
          Assert.fail('No messages expected');
        });

        call.on('error', (err) => {
          Assert.strictEqual(err.code, Grpc.status.UNIMPLEMENTED);
          barrier.pass();
        });

        call.end();

        return barrier;
      });
    });
  });

  describe('Echo service', () => {
    let server;
    let client;

    before(async () => {
      const protoFile = Path.join(__dirname, 'proto', 'echo_service.proto');
      const { EchoService } = loadProtoFile(protoFile);

      server = new Server();
      server.addService(EchoService.service, {
        echo (call, callback) {
          callback(null, call.request);
        }
      });

      const port = await server.bind('localhost:0', serverInsecureCreds);
      client = new EchoService(`localhost:${port}`, clientInsecureCreds);
      server.start();
    });

    after(() => {
      server.tryShutdown();
    });

    it('should echo the recieved message directly', () => {
      const barrier = new Barrier();

      client.echo({ value: 'test value', value2: 3 }, (error, response) => {
        Assert.ifError(error);
        Assert.deepStrictEqual(response, { value: 'test value', value2: 3 });
        barrier.pass();
      });

      return barrier;
    });
  });

  describe('Generic client and server', () => {
    function toString (val) {
      return val.toString();
    }

    function toBuffer (str) {
      return Buffer.from(str);
    }

    function capitalize (str) {
      return str.charAt(0).toUpperCase() + str.slice(1);
    }

    const stringServiceAttrs = {
      capitalize: {
        path: '/string/capitalize',
        requestStream: false,
        responseStream: false,
        requestSerialize: toBuffer,
        requestDeserialize: toString,
        responseSerialize: toBuffer,
        responseDeserialize: toString
      }
    };

    describe('String client and server', () => {
      let client;
      let server;

      before(async () => {
        server = new Server();

        server.addService(stringServiceAttrs, {
          capitalize (call, callback) {
            callback(null, capitalize(call.request));
          }
        });

        const port = await server.bind('localhost:0', serverInsecureCreds);
        server.start();
        const Client = Grpc.makeGenericClientConstructor(stringServiceAttrs);
        client = new Client(`localhost:${port}`, clientInsecureCreds);
      });

      after(() => {
        server.tryShutdown();
      });

      it('Should respond with a capitalized string', () => {
        const barrier = new Barrier();

        client.capitalize('abc', (err, response) => {
          Assert.ifError(err);
          Assert.strictEqual(response, 'Abc');
          barrier.pass();
        });

        return barrier;
      });
    });
  });

  it('throws when unimplemented methods are called', () => {
    const server = new Server();

    Assert.throws(() => {
      server.addProtoService();
    }, /not implemented. use addService\(\) instead/);

    Assert.throws(() => {
      server.forceShutdown();
    }, /not implemented/);

    Assert.throws(() => {
      server.addHttp2Port();
    }, /not implemented/);
  });
});
