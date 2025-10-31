import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

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
  return twMerge(clsx(inputs))
}

/**
 * Format timestamp for message display
 * 
 * Converts ISO timestamp to user-friendly time format
 * Uses 12-hour format with AM/PM for consistency across the app
 * 
 * @param timestamp - ISO timestamp string or Date object
 * @returns Formatted time string (e.g., "2:30 PM", "10:45 AM")
 * 
 * @example
 * formatTimestamp("2023-10-27T14:30:00Z") // "2:30 PM"
 * formatTimestamp(new Date()) // Current time formatted
 */
export function formatTimestamp(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date)
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
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  // Check if date is today
  if (date.toDateString() === today.toDateString()) {
    return 'Today'
  } 
  // Check if date is yesterday
  else if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday'
  } 
  // Format older dates with month/day, include year if different
  else {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
    }).format(date)
  }
}

/**
 * Generate unique thread identifier
 * 
 * Creates a unique ID for new conversation threads
 * Format: "thread_{timestamp}_{randomString}"
 * Ensures uniqueness across concurrent thread creation
 * 
 * @returns Unique thread ID string
 * 
 */
/**
 * Truncate text with ellipsis for UI display
 * 
 * Safely truncates long text strings for display in constrained UI elements
 * like thread previews, ensuring proper word boundaries when possible
 * 
 * @param text - Text string to potentially truncate
 * @param maxLength - Maximum allowed character length
 * @returns Truncated text with ellipsis if needed
 * 
 * @example
 * truncateText("This is a very long message", 20) // "This is a very long..."
 * truncateText("Short text", 50) // "Short text" (unchanged)
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength).trim() + '...'
}