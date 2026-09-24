import { memoryRaise } from './memory-raise.core';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';

describe('what to propose after an out-of-memory kill', () => {
  it('proposes doubling the limit, for the container that was killed', () => {
    const action = memoryRaise(256, 'web');
    expect(action.type).toBe(SuggestedActionType.RESOURCES);
    expect(action.payload).toEqual({
      limits: { memory: '512Mi' },
      containerName: 'web',
    });
    expect(action.message).toBe('Raise the memory limit from 256Mi to 512Mi.');
  });

  it('never proposes touching the memory reserved on the machine', () => {
    expect(memoryRaise(512, null).payload).not.toHaveProperty('requests');
  });

  it('starts from the default when no limit could be read', () => {
    expect(memoryRaise(null, null).payload).toEqual({
      limits: { memory: '512Mi' },
    });
  });

  it('stops at the cap', () => {
    expect(memoryRaise(6144, null).payload).toEqual({
      limits: { memory: '8Gi' },
    });
  });

  it('proposes looking for a leak instead of raising past the cap', () => {
    const action = memoryRaise(8192, null);
    expect(action.type).toBe(SuggestedActionType.MANUAL);
    expect(action.payload).toBeUndefined();
    expect(action.message).toContain('8Gi');
  });
});
