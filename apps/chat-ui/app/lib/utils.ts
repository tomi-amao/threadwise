import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * ThreadWise Chat UI Utilities
 *
 * Common utility functions for the ThreadWise chat interface
 * Includes styling helpers, date formatting, and ID generation
 */

/**
 * Tailwind CSS class name merger utility
 *
 * Combines clsx for conditional classes with tailwind-merge for proper
 * Tailwind CSS class deduplication and override handling
 *
 * @param inputs - Array of class values (strings, objects, arrays)
 * @returns Merged and deduplicated class string
 *
 * @example
 * cn("bg-red-500", "bg-blue-500") // "bg-blue-500" (blue overrides red)
 * cn("p-4", isActive && "bg-primary", "hover:bg-primary/90")
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format date for thread list display
 *
 * Provides human-friendly relative date formatting:
 * - "Today" for messages from today
 * - "Yesterday" for messages from yesterday
 * - "Oct 27" or "Oct 27, 2023" for older messages
 *
 * @param timestamp - ISO timestamp string or Date object
 * @returns Formatted date string
 *
 * @example
 * formatDate(new Date()) // "Today"
 * formatDate(yesterdayDate) // "Yesterday"
 * formatDate("2023-10-25T10:00:00Z") // "Oct 25" or "Oct 25, 2023"
 */
export function formatDate(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Check if date is today
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  // Check if date is yesterday
  else if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  // Format older dates with month/day, include year if different
  else {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
    }).format(date);
  }
}
