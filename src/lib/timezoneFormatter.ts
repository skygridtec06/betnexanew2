/**
 * Timezone Formatter Utility
 * Converts times to East African Time (EAT / Nairobi timezone)
 */

/**
 * Format a time string or ISO timestamp to East African Time (EAT / UTC+3)
 * Handles both HH:mm format and full ISO timestamps
 * If isoTimestamp is provided, it takes priority for accurate conversion
 */
export const formatTimeInEAT = (timeInput: string | undefined | null, isoTimestamp?: string | undefined | null): string => {
  if (!timeInput && !isoTimestamp) return 'N/A';

  try {
    // If we have a full ISO timestamp, use it for accurate conversion (takes priority)
    if (isoTimestamp && (isoTimestamp.includes('T') || isoTimestamp.includes('-'))) {
      const utcDate = new Date(isoTimestamp);
      if (!isNaN(utcDate.getTime())) {
        // Explicitly add 3 hours for EAT (UTC+3)
        const eatDate = new Date(utcDate.getTime() + 3 * 60 * 60 * 1000);
        
        // Format as HH:mm AM/PM
        let hours = eatDate.getUTCHours();
        const minutes = String(eatDate.getUTCMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12; // 12-hour format
        
        return `${hours}:${minutes} ${ampm}`;
      }
    }

    // Check if timeInput is a full ISO timestamp
    if (timeInput && (timeInput.includes('T') || timeInput.includes('-'))) {
      // Parse as ISO timestamp
      const utcDate = new Date(timeInput);
      if (isNaN(utcDate.getTime())) {
        return timeInput; // Return original if invalid
      }
      
      // Explicitly add 3 hours for EAT (UTC+3)
      const eatDate = new Date(utcDate.getTime() + 3 * 60 * 60 * 1000);
      
      // Format as HH:mm AM/PM
      let hours = eatDate.getUTCHours();
      const minutes = String(eatDate.getUTCMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // 12-hour format
      
      return `${hours}:${minutes} ${ampm}`;
    }

    // If it's just HH:mm format (e.g., "11:49")
    if (timeInput && timeInput.includes(':')) {
      // Parse HH:mm format and assume it's already in the client timezone
      const [hours, minutes] = timeInput.split(':').map(Number);
      
      // Try to format using Intl as fallback
      const tempDate = new Date();
      tempDate.setHours(hours, minutes, 0, 0);
      
      let displayHours = hours;
      const ampm = displayHours >= 12 ? 'PM' : 'AM';
      displayHours = displayHours % 12;
      displayHours = displayHours ? displayHours : 12; // 12-hour format
      
      return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
    }

    return timeInput || 'N/A';
  } catch (error) {
    console.warn('⚠️ Error formatting time in EAT:', error, 'Input:', timeInput);
    return timeInput || 'N/A';
  }
};

/**
 * Format a date and time combination to East African Time (UTC+3)
 * Combines date string and time string
 */
export const formatDateTimeInEAT = (dateStr: string | undefined, timeStr: string | undefined): string => {
  if (!dateStr && !timeStr) return 'N/A';
  if (!timeStr) return dateStr || 'N/A';

  try {
    if (dateStr && timeStr) {
      const [day, month, year] = dateStr.split('/').map(Number);
      const [hours, minutes] = timeStr.split(':').map(Number);
      
      // Create UTC date: YYYY-MM-DDTHH:mm:00Z
      const isoString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`;
      
      const utcDate = new Date(isoString);
      if (isNaN(utcDate.getTime())) {
        return `${dateStr}, ${timeStr}`;
      }

      // Add 3 hours for EAT (UTC+3)
      const eatDate = new Date(utcDate.getTime() + 3 * 60 * 60 * 1000);
      
      // Format time
      let hours12 = eatDate.getUTCHours();
      const mins = String(eatDate.getUTCMinutes()).padStart(2, '0');
      const ampm = hours12 >= 12 ? 'PM' : 'AM';
      hours12 = hours12 % 12;
      hours12 = hours12 ? hours12 : 12;

      return `${dateStr}, ${hours12}:${mins} ${ampm}`;
    }

    return `${dateStr || ''} ${timeStr || ''}`;
  } catch (error) {
    console.warn('⚠️ Error formatting date and time in EAT:', error);
    return `${dateStr || ''} ${timeStr || ''}`;
  }
};

/**
 * Format a date string (in various formats) to EAT (UTC+3)
 * Accepts: ISO strings, locale strings, and custom date formats
 */
export const formatDateInEAT = (dateInput: string | Date | undefined | null): string => {
  if (!dateInput) return 'N/A';

  try {
    let utcDate: Date;
    
    if (typeof dateInput === 'string') {
      utcDate = new Date(dateInput);
      if (isNaN(utcDate.getTime())) {
        return dateInput;
      }
    } else {
      utcDate = dateInput;
    }

    // Add 3 hours for EAT (UTC+3)
    const eatDate = new Date(utcDate.getTime() + 3 * 60 * 60 * 1000);
    
    // Format: MM/DD/YYYY, HH:mm AM/PM
    const month = String(eatDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eatDate.getUTCDate()).padStart(2, '0');
    const year = eatDate.getUTCFullYear();
    
    let hours = eatDate.getUTCHours();
    const minutes = String(eatDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(eatDate.getUTCSeconds()).padStart(2, '0');
    
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    
    return `${month}/${day}/${year}, ${hours}:${minutes}:${seconds} ${ampm}`;
  } catch (error) {
    console.warn('⚠️ Error formatting date in EAT:', error);
    return String(dateInput);
  }
};

/**
 * Format a UTC ISO datetime for display in East African Time.
 * Returns both the date and time separately for bet history screens.
 */
export const formatDateTimeForDisplayEAT = (dateTime: string | undefined | null): { date: string; time: string } => {
  if (!dateTime) {
    return { date: 'N/A', time: 'N/A' };
  }

  try {
    const parsedDate = new Date(dateTime);
    if (isNaN(parsedDate.getTime())) {
      return { date: 'N/A', time: 'N/A' };
    }

    const date = `${String(parsedDate.getUTCDate()).padStart(2, '0')}/${String(parsedDate.getUTCMonth() + 1).padStart(2, '0')}/${parsedDate.getUTCFullYear()}`;
    let hours = parsedDate.getUTCHours();
    const minutes = String(parsedDate.getUTCMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;

    return {
      date,
      time: `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`,
    };
  } catch (error) {
    console.warn('⚠️ Error formatting bet timestamp in UTC:', error);
    return { date: 'N/A', time: 'N/A' };
  }
};

/**
 * Convert a transaction date string to EAT format (UTC+3)
 * Handles locale strings like "26/2/2026, 11:49 AM"
 */
export const formatTransactionDateInEAT = (dateStr: string | undefined | null): string => {
  if (!dateStr) return 'N/A';

  try {
    // Try to parse the date string
    const utcDate = new Date(dateStr);
    
    if (isNaN(utcDate.getTime())) {
      return dateStr; // Return original if can't parse
    }

    // Add 3 hours for EAT (UTC+3)
    const eatDate = new Date(utcDate.getTime() + 3 * 60 * 60 * 1000);
    
    // Format: MM/DD/YYYY, HH:mm:ss AM/PM
    const month = String(eatDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eatDate.getUTCDate()).padStart(2, '0');
    const year = eatDate.getUTCFullYear();
    
    let hours = eatDate.getUTCHours();
    const minutes = String(eatDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(eatDate.getUTCSeconds()).padStart(2, '0');
    
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    
    return `${month}/${day}/${year}, ${hours}:${minutes}:${seconds} ${ampm}`;
  } catch (error) {
    console.warn('⚠️ Error formatting transaction date in EAT:', error);
    return dateStr;
  }
};
