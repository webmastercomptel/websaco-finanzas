// src/common/utils/mapper.utils.ts
import { Types } from 'mongoose';

/**
 * Shared helpers for the document → contract mappers. Every function here is
 * pure and total: a mapper must never throw on a half-populated document,
 * because a rendering failure in one row should not take down a whole listing.
 */

/** Normalizes a Mongo ObjectId (or populated doc / string) to its string form. */
export const idToString = (
  value: Types.ObjectId | string | { _id: Types.ObjectId } | null | undefined,
): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === 'object' && '_id' in value) return value._id.toString();
  return String(value);
};

/** Converts a Date (or date-ish value) to an ISO 8601 string, or null. */
export const toIso = (
  date: Date | string | null | undefined,
): string | null => {
  if (!date) return null;
  const parsed = date instanceof Date ? date : new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
