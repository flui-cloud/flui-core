import { shapeNameOf } from './shape-name';

describe('the name a shape is bought by', () => {
  const sizes = [
    { id: '109', name: 'cpx22' },
    { id: 'b2-7', name: 'b2-7' },
  ];

  it('turns a provider id into its catalogue name', () => {
    expect(shapeNameOf('109', sizes)).toBe('cpx22');
  });

  it('keeps a name that already is one', () => {
    expect(shapeNameOf('cpx22', sizes)).toBe('cpx22');
  });

  it('keeps what it cannot find', () => {
    expect(shapeNameOf('cx99', sizes)).toBe('cx99');
  });
});
