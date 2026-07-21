/**
 * @fileoverview Async JSON helpers
 * @description Promise wrappers around yieldable-json's non-blocking stringify/parse —
 * the one place the callback-to-promise conversion lives.
 */

import yj from 'yieldable-json';

/**
 * Non-blocking JSON stringify (yieldable-json) as a promise.
 * @param {*} value - Value to serialize
 * @returns {Promise<string>} JSON string
 */
export const stringifyAsync = value =>
  new Promise((resolve, reject) => {
    yj.stringifyAsync(value, (err, result) => (err ? reject(err) : resolve(result)));
  });

/**
 * Non-blocking JSON parse (yieldable-json) as a promise.
 * @param {string} json - JSON string to parse
 * @returns {Promise<*>} Parsed value
 */
export const parseAsync = json =>
  new Promise((resolve, reject) => {
    yj.parseAsync(json, (err, result) => (err ? reject(err) : resolve(result)));
  });
