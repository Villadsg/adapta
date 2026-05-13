/**
 * EventTags — dynamic news-derived event categorization.
 *
 * Tags are scored per-ticker per-run by embedding-cosine against a curated
 * vocabulary. Multiple tags can fire on a single ticker, in addition to its
 * static sector. Tags whose `sectors` field doesn't match the ticker's sector
 * are skipped (so a SaaS company can't get `fda_pending`).
 *
 * Threshold tuning: anchors are written as canonical headlines; if a tag
 * over- or under-fires, adjust its `threshold` (typical range 0.55–0.72).
 */

const ALL = ['all'];

const EVENT_TAGS = [
  // ── Biotech / Medtech regulatory ──
  { id: 'fda_pending', label: 'FDA approval pending', sectors: ['biotech', 'medtech'], threshold: 0.62, anchors: [
    'FDA PDUFA decision date set for upcoming review of drug application',
    'Company submits new drug application to FDA awaiting approval decision',
    'Awaiting FDA advisory committee vote on lead drug candidate',
    'Regulatory decision expected within weeks on pending therapy approval',
  ]},
  { id: 'fda_approval', label: 'FDA approval', sectors: ['biotech', 'medtech'], threshold: 0.62, anchors: [
    'FDA approves new drug for treatment in landmark regulatory decision',
    'Company receives FDA clearance for next-generation medical device',
    'Regulator grants approval for therapy expanding label indications',
  ]},
  { id: 'fda_rejection', label: 'FDA rejection', sectors: ['biotech', 'medtech'], threshold: 0.62, anchors: [
    'FDA issues complete response letter rejecting drug application',
    'Regulator declines to approve therapy citing data deficiencies',
    'FDA rejects device clearance pending additional clinical evidence',
  ]},
  { id: 'clinical_readout', label: 'Clinical readout', sectors: ['biotech', 'medtech'], threshold: 0.60, anchors: [
    'Company reports topline results from pivotal phase three trial',
    'Clinical trial data readout shows efficacy versus placebo',
    'Interim analysis from registrational study released today',
  ]},

  // ── Earnings / guidance ──
  { id: 'guidance_cut', label: 'Guidance cut', sectors: ALL, threshold: 0.60, anchors: [
    'Company cuts full-year revenue guidance citing weakening demand',
    'Management lowers earnings outlook for the coming quarter',
    'Guidance reduced as outlook deteriorates across key end markets',
  ]},
  { id: 'guidance_raise', label: 'Guidance raised', sectors: ALL, threshold: 0.60, anchors: [
    'Company raises full-year revenue guidance after strong quarter',
    'Management lifts earnings outlook citing accelerating demand',
    'Guidance increased on better than expected execution and pipeline',
  ]},
  { id: 'earnings_beat', label: 'Earnings beat', sectors: ALL, threshold: 0.60, anchors: [
    'Company beats earnings estimates with stronger than expected revenue',
    'Quarterly results top analyst expectations on revenue and margin',
    'Earnings beat driven by strong demand and pricing power',
  ]},
  { id: 'earnings_miss', label: 'Earnings miss', sectors: ALL, threshold: 0.60, anchors: [
    'Company misses earnings estimates with weaker than expected results',
    'Quarterly revenue falls short of analyst expectations',
    'Earnings miss driven by margin compression and slowing demand',
  ]},

  // ── M&A / corporate ──
  { id: 'mna_target', label: 'M&A target', sectors: ALL, threshold: 0.62, anchors: [
    'Company receives takeover bid from strategic acquirer',
    'Reports suggest private equity firm is preparing acquisition offer',
    'Stock surges on report of buyout interest from larger competitor',
  ]},
  { id: 'mna_acquirer', label: 'M&A acquirer', sectors: ALL, threshold: 0.62, anchors: [
    'Company announces acquisition of competitor expanding portfolio',
    'Strategic acquisition closes with cost synergy realization expected',
    'Company agrees to acquire rival in cash and stock transaction',
  ]},

  // ── Contracts / commercial ──
  { id: 'contract_win', label: 'Contract win', sectors: ALL, threshold: 0.60, anchors: [
    'Company wins major contract award beating competitive field',
    'Stock surges on news of large new customer contract',
    'Major design win secured with key strategic customer',
  ]},
  { id: 'contract_loss', label: 'Contract loss', sectors: ALL, threshold: 0.60, anchors: [
    'Company loses major contract to rival ending multi-year relationship',
    'Key customer contract not renewed citing budget constraints',
    'Stock drops after losing competitive bid for flagship program',
  ]},

  // ── People / org ──
  { id: 'executive_change', label: 'Executive change', sectors: ALL, threshold: 0.62, anchors: [
    'Chief executive announces departure effective end of quarter',
    'Company appoints new CEO succeeding longtime leader',
    'CFO resigns amid management transition at company',
  ]},
  { id: 'layoffs', label: 'Layoffs', sectors: ALL, threshold: 0.62, anchors: [
    'Company announces layoffs cutting workforce by significant percentage',
    'Restructuring plan eliminates positions across multiple divisions',
    'Job cuts announced as part of cost reduction initiative',
  ]},

  // ── Capital structure ──
  { id: 'buyback', label: 'Buyback', sectors: ALL, threshold: 0.62, anchors: [
    'Board authorizes new share repurchase program',
    'Company announces accelerated stock buyback plan',
    'Buyback expansion signals confidence in cash generation',
  ]},
  { id: 'dividend_change', label: 'Dividend change', sectors: ALL, threshold: 0.62, anchors: [
    'Board increases quarterly dividend payout to shareholders',
    'Company suspends dividend amid cash flow pressure',
    'Dividend raised reflecting strong free cash flow generation',
  ]},
  { id: 'dilution', label: 'Dilution / offering', sectors: ALL, threshold: 0.60, anchors: [
    'Company prices secondary offering of common stock at discount',
    'Dilutive equity raise announced to fund operations',
    'Stock drops on news of share issuance and capital raise',
  ]},

  // ── Legal / regulatory ──
  { id: 'lawsuit', label: 'Lawsuit', sectors: ALL, threshold: 0.62, anchors: [
    'Class action lawsuit filed alleging product defects',
    'Court verdict delivers material liability against company',
    'Securities lawsuit filed by shareholders alleging disclosure violations',
  ]},
  { id: 'doj_ftc_probe', label: 'DOJ/FTC probe', sectors: ALL, threshold: 0.62, anchors: [
    'Department of Justice opens antitrust investigation into company',
    'FTC launches probe into business practices and competition concerns',
    'Regulatory enforcement action announced for alleged violations',
  ]},

  // ── Macro exposure ──
  { id: 'tariff_exposure', label: 'Tariff exposure', sectors: ALL, threshold: 0.60, anchors: [
    'New tariffs threaten company supply chain and pricing structure',
    'Import duties expected to compress margins on key product lines',
    'Trade policy changes create cost pressure on manufacturing',
  ]},
  { id: 'china_revenue_shift', label: 'China revenue shift', sectors: ALL, threshold: 0.60, anchors: [
    'Company reduces exposure to China amid export restrictions',
    'Sales to Chinese customers decline materially in latest quarter',
    'Geographic revenue mix shifts away from China toward domestic markets',
  ]},
  { id: 'revenue_mix_shift', label: 'Revenue mix shift', sectors: ALL, threshold: 0.60, anchors: [
    'Company reports change in revenue origin across business segments',
    'Geographic mix shifts as international sales grow faster than domestic',
    'Segment reporting reveals significant change in revenue composition',
  ]},

  // ── Operations / safety ──
  { id: 'production_halt', label: 'Production halt', sectors: ALL, threshold: 0.62, anchors: [
    'Production halted at primary manufacturing facility',
    'Plant shutdown disrupts supply of key product lines',
    'Manufacturing operations suspended pending safety review',
  ]},
  { id: 'recall', label: 'Recall', sectors: ALL, threshold: 0.62, anchors: [
    'Company issues voluntary recall of product over safety concerns',
    'Mandatory recall announced after defect reports surface',
    'Product recall expanded across multiple markets and lots',
  ]},

  // ── Cybersecurity ──
  { id: 'cyber_breach', label: 'Cyber breach', sectors: ALL, threshold: 0.62, anchors: [
    'Company discloses data breach affecting customer records',
    'Cyber incident exposes sensitive information of users',
    'Ransomware attack disrupts company operations',
  ]},

  // ── Analyst / sentiment ──
  { id: 'analyst_upgrade_wave', label: 'Analyst upgrades', sectors: ALL, threshold: 0.62, anchors: [
    'Multiple analysts upgrade stock rating citing improved outlook',
    'Wall Street raises price targets across the board',
    'Analyst upgrades cite strengthening fundamentals and execution',
  ]},
  { id: 'analyst_downgrade_wave', label: 'Analyst downgrades', sectors: ALL, threshold: 0.62, anchors: [
    'Multiple analysts downgrade stock citing deteriorating outlook',
    'Wall Street cuts price targets across the board',
    'Analyst downgrades cite weakening fundamentals and competitive pressure',
  ]},
  { id: 'short_report', label: 'Short report', sectors: ALL, threshold: 0.62, anchors: [
    'Short seller publishes report alleging accounting irregularities',
    'Activist short report targets company business model',
    'Stock drops after short seller raises governance concerns',
  ]},
  { id: 'insider_buying', label: 'Insider buying', sectors: ALL, threshold: 0.62, anchors: [
    'Insiders purchase shares signaling confidence in stock',
    'Executive open market buying disclosed in regulatory filing',
    'Director adds to position with significant share purchase',
  ]},
];

const TAG_LABELS = Object.fromEntries(EVENT_TAGS.map(t => [t.id, t.label]));

function tagApplies(tag, sector) {
  if (!tag.sectors || tag.sectors.includes('all')) return true;
  return tag.sectors.includes(sector);
}

module.exports = { EVENT_TAGS, TAG_LABELS, tagApplies };
