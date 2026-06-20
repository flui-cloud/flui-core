import { translateShellStatement } from './mongo-shell';

describe('translateShellStatement', () => {
  it('show dbs', () => {
    const p = translateShellStatement('show dbs', 'app');
    expect(p).toMatchObject({
      database: 'admin',
      command: { listDatabases: 1 },
      method: 'listDatabases',
      shape: 'databases',
      mutation: false,
    });
  });

  it('show collections uses the current db', () => {
    const p = translateShellStatement('show collections', 'shop');
    expect(p).toMatchObject({
      database: 'shop',
      command: { listCollections: 1, nameOnly: true },
      shape: 'collectionNames',
      mutation: false,
    });
  });

  it('find applies the default limit and cursor shape', () => {
    const p = translateShellStatement('db.users.find({ a: 1 })', 'shop');
    expect(p).toMatchObject({
      database: 'shop',
      method: 'find',
      shape: 'cursor',
      mutation: false,
      command: { find: 'users', filter: { a: 1 }, limit: 20 },
    });
  });

  it('find honours an explicit .limit() and .sort()', () => {
    const p = translateShellStatement(
      'db.users.find({}).sort({ a: -1 }).limit(5)',
      'shop',
    );
    expect(p.command).toMatchObject({
      find: 'users',
      limit: 5,
      sort: { a: -1 },
    });
  });

  it('findOne sets limit 1 and firstDoc shape', () => {
    const p = translateShellStatement('db.users.findOne({ a: 1 })', 'shop');
    expect(p).toMatchObject({
      method: 'find',
      shape: 'firstDoc',
      command: { find: 'users', limit: 1 },
    });
  });

  it('aggregate', () => {
    const p = translateShellStatement(
      'db.users.aggregate([{ $match: { a: 1 } }])',
      'shop',
    );
    expect(p).toMatchObject({
      method: 'aggregate',
      shape: 'cursor',
      mutation: false,
    });
    expect(p.command).toMatchObject({ aggregate: 'users' });
  });

  it('countDocuments', () => {
    const p = translateShellStatement(
      'db.users.countDocuments({ a: 1 })',
      'shop',
    );
    expect(p).toMatchObject({
      method: 'count',
      shape: 'count',
      command: { count: 'users', query: { a: 1 } },
    });
  });

  it('distinct', () => {
    const p = translateShellStatement('db.users.distinct("status")', 'shop');
    expect(p).toMatchObject({
      method: 'distinct',
      shape: 'distinct',
      command: { distinct: 'users', key: 'status' },
    });
  });

  it('insertOne is a mutation', () => {
    const p = translateShellStatement('db.users.insertOne({ a: 1 })', 'shop');
    expect(p).toMatchObject({
      method: 'insert',
      shape: 'insert',
      mutation: true,
    });
    expect(p.command).toMatchObject({ insert: 'users', documents: [{ a: 1 }] });
  });

  it('updateMany builds a multi update', () => {
    const p = translateShellStatement(
      'db.users.updateMany({ a: 1 }, { $set: { x: 2 } })',
      'shop',
    );
    expect(p).toMatchObject({ method: 'update', mutation: true });
    expect(p.command).toMatchObject({
      update: 'users',
      updates: [
        { q: { a: 1 }, u: { $set: { x: 2 } }, multi: true, upsert: false },
      ],
    });
  });

  it('deleteOne limits to 1', () => {
    const p = translateShellStatement('db.users.deleteOne({ a: 1 })', 'shop');
    expect(p).toMatchObject({ method: 'delete', mutation: true });
    expect(p.command).toMatchObject({
      delete: 'users',
      deletes: [{ q: { a: 1 }, limit: 1 }],
    });
  });

  it('drop is a raw mutation', () => {
    const p = translateShellStatement('db.users.drop()', 'shop');
    expect(p).toMatchObject({
      method: 'drop',
      shape: 'raw',
      mutation: true,
      command: { drop: 'users' },
    });
  });

  it('createIndex derives a default index name', () => {
    const p = translateShellStatement('db.users.createIndex({ a: 1 })', 'shop');
    expect(p).toMatchObject({ method: 'createIndexes', mutation: true });
    expect(p.command).toMatchObject({
      createIndexes: 'users',
      indexes: [{ key: { a: 1 }, name: 'a_1' }],
    });
  });

  it('runCommand with a read command is not a mutation', () => {
    const p = translateShellStatement('db.runCommand({ ping: 1 })', 'shop');
    expect(p).toMatchObject({ method: 'ping', shape: 'raw', mutation: false });
  });

  it('runCommand with a non-read command is a mutation', () => {
    const p = translateShellStatement(
      'db.runCommand({ createUser: "x" })',
      'shop',
    );
    expect(p.mutation).toBe(true);
  });

  it('getCollectionNames', () => {
    const p = translateShellStatement('db.getCollectionNames()', 'shop');
    expect(p).toMatchObject({
      shape: 'collectionNames',
      command: { listCollections: 1, nameOnly: true },
    });
  });

  it('db.stats()', () => {
    const p = translateShellStatement('db.stats()', 'shop');
    expect(p.command).toMatchObject({ dbStats: 1 });
  });

  it('getCollection("name") then a method', () => {
    const p = translateShellStatement(
      'db.getCollection("my-coll").find({})',
      'shop',
    );
    expect(p.command).toMatchObject({ find: 'my-coll' });
  });

  it('bracket index access selects the collection', () => {
    const p = translateShellStatement('db["my-collection"].find({})', 'shop');
    expect(p.command).toMatchObject({ find: 'my-collection' });
  });

  it('rejects statements that do not start with db', () => {
    expect(() => translateShellStatement('foo.bar()', 'shop')).toThrow();
  });

  it('rejects unsupported collection methods', () => {
    expect(() =>
      translateShellStatement('db.users.frobnicate()', 'shop'),
    ).toThrow(/Unsupported method/);
  });

  it('rejects an empty statement', () => {
    expect(() => translateShellStatement('   ', 'shop')).toThrow();
  });
});
