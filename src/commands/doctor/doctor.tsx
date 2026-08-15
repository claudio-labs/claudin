import React from 'react';
import { Doctor } from 'src/platform/doctor/Doctor.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
export const call: LocalJSXCommandCall = (onDone, _context, _args) => {
  return Promise.resolve(<Doctor onDone={onDone} />);
};
