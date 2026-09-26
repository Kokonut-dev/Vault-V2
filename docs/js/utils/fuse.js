/**
 * Lightweight fuzzy search — simplified Fuse.js alternative
 * Supports typo tolerance, field weighting, threshold
 */

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function fuzzyMatch(pattern, text, threshold = 0.4) {
  if (!pattern) return { matched: true, score: 0 };
  if (!text) return { matched: false, score: 1 };
  
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  
  // Exact substring match — best score
  if (t.includes(p)) {
    return { matched: true, score: 0, indices: [[t.indexOf(p), t.indexOf(p) + p.length - 1]] };
  }
  
  // Fuzzy: check if all chars of pattern appear in order in text
  let tIndex = 0;
  let matchedChars = 0;
  for (let i = 0; i < p.length; i++) {
    const char = p[i];
    const found = t.indexOf(char, tIndex);
    if (found === -1) {
      // Try levenshtein for typo tolerance on short strings
      if (p.length <= 10 && t.length <= 50) {
        const distance = levenshtein(p, t.substring(0, p.length + 2));
        const maxLen = Math.max(p.length, t.length);
        const score = distance / maxLen;
        if (score <= threshold) {
          return { matched: true, score };
        }
      }
      return { matched: false, score: 1 };
    }
    tIndex = found + 1;
    matchedChars++;
  }
  
  // Score based on how spread out the match is
  const score = 1 - (matchedChars / t.length);
  return { matched: true, score: Math.min(score, 0.8) };
}

export class Fuse {
  constructor(list, options = {}) {
    this.list = list || [];
    this.options = {
      keys: options.keys || [],
      threshold: options.threshold ?? 0.4,
      includeScore: options.includeScore ?? true,
      includeMatches: options.includeMatches ?? false,
      minMatchCharLength: options.minMatchCharLength ?? 1,
      ...options
    };
  }
  
  setCollection(list) {
    this.list = list;
  }
  
  search(pattern) {
    if (!pattern || pattern.trim() === '') {
      return this.list.map((item, idx) => ({ item, refIndex: idx, score: 0 }));
    }
    
    const results = [];
    const lowerPattern = pattern.toLowerCase();
    
    for (let idx = 0; idx < this.list.length; idx++) {
      const item = this.list[idx];
      let bestScore = 1;
      let matched = false;
      
      // If no keys, search the item itself if string, or all values
      const searchFields = this.options.keys.length > 0 
        ? this.options.keys.map(key => {
            if (typeof key === 'string') return this.getNestedValue(item, key);
            if (typeof key === 'object' && key.name) {
              const val = this.getNestedValue(item, key.name);
              return { value: val, weight: key.weight || 1 };
            }
            return null;
          }).filter(Boolean)
        : [item];
      
      for (const field of searchFields) {
        let value, weight = 1;
        if (typeof field === 'object' && field !== null && 'value' in field) {
          value = field.value;
          weight = field.weight;
        } else {
          value = field;
        }
        
        if (!value) continue;
        
        const text = Array.isArray(value) ? value.join(' ') : String(value);
        const { matched: isMatched, score } = fuzzyMatch(lowerPattern, text, this.options.threshold);
        
        if (isMatched) {
          matched = true;
          const weightedScore = score / weight;
          if (weightedScore < bestScore) bestScore = weightedScore;
        }
      }
      
      if (matched) {
        results.push({
          item,
          refIndex: idx,
          score: bestScore,
        });
      }
    }
    
    // Sort by score ascending (lower is better)
    results.sort((a, b) => a.score - b.score);
    
    return results;
  }
  
  getNestedValue(obj, path) {
    if (!obj || !path) return null;
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }
}

export default Fuse;
