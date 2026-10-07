const relevant = /\b(ai|artificial intelligence|grok|gpt\w*|llm\w*|agents?|software|saas|startups?|founders?|indie|coding|code|automation|automate|distribution|products?|marketing|monetiz\w*|business|building|builders?|revenue|customers?|launch\w*)\b/i;
const hardSkip = /\b(ai safety|alignment debate|culture wars?|partisan|rage bait)\b/i;
const unrelated = /\b(election\w*|democrats?|republicans?|trump|biden|geopolitic\w*|war|invasion|celebrity|kardashian\w*|nfl|nba|football|soccer|giveaway|world cup)\b/i;
export function cheapSkip(text: string): string | null {
  if (hardSkip.test(text)) return 'Excluded debate or culture-war topic';
  if (unrelated.test(text) && !relevant.test(text)) return 'Unrelated news, politics, sports or giveaway';
  return null; // Neutral posts reach the model; keywords are not a mandatory allowlist.
}
