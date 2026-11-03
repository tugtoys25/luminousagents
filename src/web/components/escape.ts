import type { Row } from '../../site-content/types';

/** Text from a content row ('' when missing or not text). */
export const text = (row: Row, key: string): string => {
  const v = row[key];
  return typeof v === 'string' ? v : '';
};

export const flag = (row: Row, key: string): boolean => row[key] === true;

/** Splits text on blank lines into paragraphs. */
export const paragraphs = (value: string): string[] =>
  value.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
