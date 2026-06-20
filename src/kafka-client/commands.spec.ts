import { CommandParseError, parseCommand, tokenize } from './commands';

describe('kafka-shell parser', () => {
  describe('tokenize', () => {
    it('splits on whitespace', () => {
      expect(tokenize('topics list')).toEqual(['topics', 'list']);
    });
    it('honours double and single quotes', () => {
      expect(tokenize('produce t k "a b c"')).toEqual([
        'produce',
        't',
        'k',
        'a b c',
      ]);
      expect(tokenize("produce t k 'x y'")).toEqual([
        'produce',
        't',
        'k',
        'x y',
      ]);
    });
    it('supports escaped quotes inside a quote', () => {
      expect(tokenize('produce t "he said \\"hi\\""')).toEqual([
        'produce',
        't',
        'he said "hi"',
      ]);
    });
    it('throws on an unterminated quote', () => {
      expect(() => tokenize('produce t "oops')).toThrow(CommandParseError);
    });
  });

  describe('read commands', () => {
    it('parses cluster info', () => {
      expect(parseCommand('cluster info')).toMatchObject({
        verb: 'cluster.info',
        mutation: false,
      });
    });
    it('parses topics list', () => {
      expect(parseCommand('topics list').verb).toBe('topics.list');
    });
    it('parses topic describe', () => {
      expect(parseCommand('topic describe orders')).toMatchObject({
        verb: 'topic.describe',
        topic: 'orders',
        mutation: false,
      });
    });
    it('parses groups list and group lag/describe', () => {
      expect(parseCommand('groups list').verb).toBe('groups.list');
      expect(parseCommand('group lag billing')).toMatchObject({
        verb: 'group.lag',
        group: 'billing',
      });
      expect(parseCommand('group describe billing')).toMatchObject({
        verb: 'group.describe',
        group: 'billing',
      });
    });
    it('parses consume with --from-end / --partition / --limit', () => {
      expect(parseCommand('consume orders --from-end 20')).toMatchObject({
        verb: 'consume',
        topic: 'orders',
        fromEnd: 20,
        mutation: false,
      });
      expect(
        parseCommand('consume orders --from-start 5 --partition 2 --limit 3'),
      ).toMatchObject({ fromStart: 5, partition: 2, limit: 3 });
    });
    it('rejects using both --from-end and --from-start', () => {
      expect(() =>
        parseCommand('consume t --from-end 5 --from-start 5'),
      ).toThrow(/only one/i);
    });
  });

  describe('write commands', () => {
    it('flags topic create/delete as mutations', () => {
      expect(
        parseCommand('topic create orders --partitions 3 --replication 1'),
      ).toMatchObject({
        verb: 'topic.create',
        topic: 'orders',
        partitions: 3,
        replication: 1,
        mutation: true,
      });
      expect(parseCommand('topic delete orders').mutation).toBe(true);
    });
    it('parses produce positional <topic> <key> <value>', () => {
      expect(parseCommand('produce orders user-7 hello')).toMatchObject({
        verb: 'produce',
        topic: 'orders',
        key: 'user-7',
        value: 'hello',
        mutation: true,
      });
    });
    it('parses produce <topic> <value> (no key)', () => {
      expect(parseCommand('produce orders hello')).toMatchObject({
        topic: 'orders',
        value: 'hello',
      });
      expect(parseCommand('produce orders hello').key).toBeUndefined();
    });
    it('parses produce with --key/--value and quoted JSON', () => {
      expect(
        parseCommand('produce orders --key u1 --value "{\\"a\\": 1}"'),
      ).toMatchObject({ topic: 'orders', key: 'u1', value: '{"a": 1}' });
    });
    it('requires a value for produce', () => {
      expect(() => parseCommand('produce orders')).toThrow(/value/i);
    });
  });

  describe('errors', () => {
    it('rejects empty input', () => {
      expect(() => parseCommand('   ')).toThrow(CommandParseError);
    });
    it('rejects unknown commands', () => {
      expect(() => parseCommand('frobnicate stuff')).toThrow(
        /unknown command/i,
      );
    });
    it('rejects unknown subcommands', () => {
      expect(() => parseCommand('topic frob x')).toThrow(
        /unknown topic subcommand/i,
      );
    });
    it('rejects non-numeric --partitions', () => {
      expect(() => parseCommand('topic create t --partitions abc')).toThrow(
        /non-negative integer/i,
      );
    });
  });
});
