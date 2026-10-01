import { BadRequestException } from '@nestjs/common';
import { refuseRegistryAuth, withoutRegistryAuth } from './registry-auth.util';

const image = { type: 'docker_image', imageRef: 'nginx:1.25' };

describe('registry credentials on an application source', () => {
  it('refuses a credential sent with the source', () => {
    expect(() =>
      refuseRegistryAuth({ ...image, registryAuth: 'dXNlcjpwYXNz' }),
    ).toThrow(BadRequestException);
  });

  it('accepts a source without one, and treats an empty or null value as none', () => {
    expect(refuseRegistryAuth(image)).toEqual(image);
    expect(refuseRegistryAuth({ ...image, registryAuth: '' })).toEqual(image);
    expect(refuseRegistryAuth({ ...image, registryAuth: null })).toEqual(image);
  });

  it('never keeps a sealed value or a marker a client sends', () => {
    expect(
      refuseRegistryAuth({
        ...image,
        registryAuthEncrypted: 'v1:abc',
        hasRegistryAuth: true,
      }),
    ).toEqual(image);
  });

  it('strips every credential field from what a reader receives', () => {
    expect(
      withoutRegistryAuth({
        ...image,
        registryAuth: 'plain',
        registryAuthEncrypted: 'v1:abc',
      }),
    ).toEqual(image);
  });

  it('leaves other sources and non-objects untouched', () => {
    const git = { type: 'git_build', repo: 'o/r' };
    expect(withoutRegistryAuth(git)).toBe(git);
    expect(withoutRegistryAuth(null)).toBeNull();
  });
});
