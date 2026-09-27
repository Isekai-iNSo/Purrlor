import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivilegedCreator } from './membership.js';

const create = (sender: string, content: Record<string, unknown>) => ({ type: 'm.room.create', state_key: '', sender, content });

describe('isPrivilegedCreator', () => {
  it('counts the creator and additional creators on room version 12', () => {
    const event = create('@a:x', { room_version: '12', additional_creators: ['@b:x'] });
    assert.equal(isPrivilegedCreator(event, '@a:x'), true);
    assert.equal(isPrivilegedCreator(event, '@b:x'), true);
    assert.equal(isPrivilegedCreator(event, '@c:x'), false);
  });

  it('leaves older room versions to the power levels', () => {
    assert.equal(isPrivilegedCreator(create('@a:x', { room_version: '10' }), '@a:x'), false);
    assert.equal(isPrivilegedCreator(undefined, '@a:x'), false);
  });
});
