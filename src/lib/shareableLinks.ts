import { BetSlipItem } from "@/components/BettingSlip";

/**
 * Encodes bet selections into a URL-safe string
 * (Kept for backwards compatibility)
 */
export const encodeSelections = (items: BetSlipItem[]): string => {
  if (!items || items.length === 0) return "";
  
  const encoded = items.map(item => ({
    matchId: item.matchId,
    type: item.type,
    odds: item.odds,
    match: item.match,
    market: item.market,
  }));
  
  return btoa(JSON.stringify(encoded));
};

/**
 * Decodes bet selections from URL-safe string
 * (Kept for backwards compatibility)
 */
export const decodeSelections = (encoded: string): BetSlipItem[] => {
  if (!encoded) return [];
  
  try {
    const decoded = JSON.parse(atob(encoded));
    return Array.isArray(decoded) ? decoded : [];
  } catch (error) {
    console.error("Failed to decode selections:", error);
    return [];
  }
};

/**
 * Generates a shareable link with short code format
 * https://betnexa.co.ke/{code}
 * where code is 6 random alphanumeric characters
 */
export const generateShareableLink = async (items: BetSlipItem[], baseUrl: string = window.location.origin): Promise<string> => {
  if (!items || items.length === 0) return "";
  
  try {
    const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
    
    const response = await fetch(`${apiUrl}/api/bets/share-betslip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections: items })
    });

    const data = await response.json();

    if (data.success && data.code) {
      return `${baseUrl}/${data.code}`;
    } else {
      console.error('Failed to generate shareable link:', data.message);
      return "";
    }
  } catch (error) {
    console.error("Failed to generate shareable link:", error);
    return "";
  }
};

/**
 * Gets picks from URL code parameter
 * Format: /code (e.g., /a1B2c5)
 */
export const getPicksFromUrl = async (): Promise<BetSlipItem[]> => {
  try {
    const pathSegments = window.location.pathname.split('/').filter(Boolean);
    let code = null;

    // Check if there's a code in the path (e.g., /a1B2c5)
    if (pathSegments.length > 0) {
      const lastSegment = pathSegments[pathSegments.length - 1];
      // Code should be alphanumeric, 5-7 characters, not a known route
      if (/^[a-zA-Z0-9]{5,7}$/.test(lastSegment) && !['muleiadmin', 'profile', 'mybets', 'history'].includes(lastSegment)) {
        code = lastSegment;
      }
    }

    // Fallback: check query parameter for backwards compatibility
    if (!code) {
      const params = new URLSearchParams(window.location.search);
      const encoded = params.get("picks");
      if (encoded) {
        return decodeSelections(encoded);
      }
    }

    if (!code) return [];

    // Fetch betslip from backend
    const apiUrl = import.meta.env.VITE_API_URL || 'https://www.betnexabackend.co.ke';
    const response = await fetch(`${apiUrl}/api/bets/betslip/${code}`);
    const data = await response.json();

    if (data.success && data.selections) {
      return Array.isArray(data.selections) ? data.selections : [];
    }

    return [];
  } catch (error) {
    console.error("Failed to get picks from URL:", error);
    return [];
  }
};

/**
 * Clears picks from URL
 */
export const clearPicksFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  params.delete("picks");
  
  const newUrl = params.toString() 
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  
  window.history.replaceState({}, "", newUrl);
};


