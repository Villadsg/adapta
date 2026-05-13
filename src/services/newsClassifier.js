/**
 * NewsClassifier - Classifies news headlines using zero-shot anchor embeddings per sector.
 *
 * Uses EmbeddingGemma-300m cosine similarity against sector-specific
 * anchor texts to classify into:
 *   - Technical: Market analysis (charts, earnings, analyst ratings, valuations)
 *   - Fear: Specific near-term company-level threats
 *   - Win: Specific near-term company-level catalysts
 *   - Macro Fear: Abstract sector-wide headwinds and negative forces
 *   - Macro Win: Abstract sector-wide tailwinds and positive forces
 *   - Mixed: Low-confidence fallback when top categories are too close
 */

const embeddingService = require('./embeddings');
const { EVENT_TAGS, tagApplies } = require('./eventTags');

// --- Ticker-to-sector mapping ---
// Covers the full UNIVERSE from ticker-screen.js + common extras
const SECTOR_MAP = {
  // ── Small / Mid-cap ──
  // Defense / Aerospace
  KTOS: 'defense', MRCY: 'defense', RKLB: 'defense', BWXT: 'defense', AVAV: 'defense',
  AXON: 'defense', TDG: 'defense', HEI: 'defense', LDOS: 'defense', BWA: 'defense',
  CACI: 'defense', JOBY: 'defense', LUNR: 'defense', RCAT: 'defense', PLTR: 'defense',
  // Biotech / Pharma
  TWST: 'biotech', CYTK: 'biotech', ARWR: 'biotech', IONS: 'biotech', EXAS: 'biotech',
  HALO: 'biotech', NBIX: 'biotech', PCVX: 'biotech', VKTX: 'biotech', KRYS: 'biotech',
  SRPT: 'biotech', ALNY: 'biotech', BMRN: 'biotech', INCY: 'biotech', ARGX: 'biotech',
  EXEL: 'biotech', CPRX: 'biotech', XENE: 'biotech', UTHR: 'biotech', RARE: 'biotech',
  AXSM: 'biotech', IOVA: 'biotech', GMAB: 'biotech', NVO: 'biotech',
  // Clean Energy
  ENPH: 'cleanenergy', SEDG: 'cleanenergy', BE: 'cleanenergy', FSLR: 'cleanenergy',
  RUN: 'cleanenergy', AES: 'cleanenergy', CWEN: 'cleanenergy', BEPC: 'cleanenergy',
  SHLS: 'cleanenergy', VST: 'cleanenergy', CEG: 'cleanenergy',
  // SaaS / Cloud / Software
  AI: 'saas', UPST: 'saas', BRZE: 'saas', CFLT: 'saas', S: 'saas', GTLB: 'saas',
  DOCN: 'saas', PAYC: 'saas', PCTY: 'saas', GLOB: 'saas', WIX: 'saas', APPF: 'saas',
  NTNX: 'saas', JAMF: 'saas', BL: 'saas', SPSC: 'saas', BILL: 'saas', DDOG: 'saas',
  ZS: 'saas', CRWD: 'saas', MNDY: 'saas', TOST: 'saas', HUBS: 'saas', VEEV: 'saas',
  ESTC: 'saas', FRSH: 'saas', PTC: 'saas', ASAN: 'saas', PCOR: 'saas', TYL: 'saas',
  KVYO: 'saas', APP: 'saas', RDDT: 'saas', RBRK: 'saas', IOT: 'saas', DUOL: 'saas',
  // Cybersecurity
  TENB: 'cyber', QLYS: 'cyber', OKTA: 'cyber', VRNS: 'cyber', FTNT: 'cyber',
  PANW: 'cyber', NET: 'cyber', SAIL: 'cyber',
  // Fintech / Payments
  SOFI: 'fintech', LC: 'fintech', AFRM: 'fintech', PAYO: 'fintech', RELY: 'fintech',
  FOUR: 'fintech', ACIW: 'fintech', VRRM: 'fintech', HLNE: 'fintech', GPN: 'fintech',
  MQ: 'fintech', WEX: 'fintech', HOOD: 'fintech', SSNC: 'fintech',
  // Medtech / Healthcare
  INSP: 'medtech', GKOS: 'medtech', NVCR: 'medtech', TMDX: 'medtech', IRTC: 'medtech',
  DOCS: 'medtech', ALGN: 'medtech', HIMS: 'medtech', LNTH: 'medtech', MEDP: 'medtech',
  HQY: 'medtech', GMED: 'medtech', ISRG: 'medtech', DXCM: 'medtech', PODD: 'medtech',
  HOLX: 'medtech', RVMD: 'medtech', TFX: 'medtech', MMSI: 'medtech', PRCT: 'medtech',
  // Semiconductors
  AEHR: 'semis', LSCC: 'semis', AMBA: 'semis', SWKS: 'semis', RMBS: 'semis',
  CRUS: 'semis', SLAB: 'semis', ALGM: 'semis', DIOD: 'semis', PSTG: 'semis',
  MTSI: 'semis', ONTO: 'semis', NOVT: 'semis', MCHP: 'semis',
  ACLS: 'semis', SITM: 'semis', MPWR: 'semis', MRVL: 'semis', LRCX: 'semis',
  QCOM: 'semis',
  // Industrials / Infrastructure
  SAIA: 'industrial', TREX: 'industrial', ATKR: 'industrial', CWST: 'industrial',
  EXPO: 'industrial', POWL: 'industrial', ESAB: 'industrial',
  SPXC: 'industrial', CGNX: 'industrial', GNRC: 'industrial', TT: 'industrial',
  XYL: 'industrial', WMS: 'industrial', SITE: 'industrial', AAON: 'industrial',
  MATX: 'industrial',
  // Energy / Materials / Mining
  MP: 'energy', UUUU: 'energy', LEU: 'energy', WFRD: 'energy', TDW: 'energy',
  CALX: 'energy', HAYW: 'energy', IREN: 'energy', NE: 'energy', RIG: 'energy',
  // Consumer / Retail / Food
  CELH: 'consumer', SMPL: 'consumer', WING: 'consumer', ELF: 'consumer', SFM: 'consumer',
  DORM: 'consumer', CARG: 'consumer', TTMI: 'consumer',
  SHAK: 'consumer', BROS: 'consumer', CAVA: 'consumer', TXRH: 'consumer', DECK: 'consumer',
  EPAM: 'consumer',

  // ── Large / Mega-cap ──
  // Defense / Aerospace
  LHX: 'defense', HII: 'defense', TXT: 'defense', CW: 'defense',
  RTX: 'defense', GD: 'defense', NOC: 'defense', BAH: 'defense',
  // Biotech / Pharma
  REGN: 'biotech', VRTX: 'biotech', TECH: 'biotech', BIO: 'biotech',
  MRNA: 'biotech', BIIB: 'biotech', ILMN: 'biotech', MDGL: 'biotech', LEGN: 'biotech',
  INSM: 'biotech', FOLD: 'biotech', ACLX: 'biotech', TGTX: 'biotech', DAWN: 'biotech',
  LLY: 'biotech', ABBV: 'biotech', AZN: 'biotech', AMGN: 'biotech',
  JAZZ: 'biotech', NTRA: 'biotech', ITCI: 'biotech',
  // Clean Energy / Utilities
  NEE: 'cleanenergy', ORA: 'cleanenergy', FLNC: 'cleanenergy',
  // SaaS / Cloud / Software
  SNOW: 'saas', MDB: 'saas', TEAM: 'saas', WDAY: 'saas', NOW: 'saas',
  CDNS: 'saas', SNPS: 'saas', MANH: 'saas', GWRE: 'saas', DOCU: 'saas',
  ROKU: 'saas', U: 'saas', PATH: 'saas', PINS: 'saas', SNAP: 'saas',
  TTD: 'saas', GRAB: 'saas', SE: 'saas', SHOP: 'saas',
  MSFT: 'saas', ADBE: 'saas', CRM: 'saas', ORCL: 'saas', INTU: 'saas', SAP: 'saas',
  GDDY: 'saas', ZM: 'saas',
  // Cybersecurity
  RPD: 'cyber', FICO: 'cyber',
  // Fintech / Payments
  FIS: 'fintech', FISV: 'fintech', PYPL: 'fintech', COIN: 'fintech', MKTX: 'fintech',
  LPLA: 'fintech', IBKR: 'fintech', NDAQ: 'fintech', CBOE: 'fintech', ICE: 'fintech',
  CME: 'fintech', MSCI: 'fintech', SPGI: 'fintech',
  V: 'fintech', MA: 'fintech', AXP: 'fintech',
  TW: 'fintech', CPAY: 'fintech', EFX: 'fintech',
  // Medtech / Healthcare
  EW: 'medtech', STE: 'medtech', HSIC: 'medtech', XRAY: 'medtech', WST: 'medtech',
  IDXX: 'medtech', IQV: 'medtech', ZBH: 'medtech', BSX: 'medtech', PHG: 'medtech',
  RMD: 'medtech', GEHC: 'medtech',
  UNH: 'medtech', ABT: 'medtech', TMO: 'medtech', SYK: 'medtech', BDX: 'medtech', ZTS: 'medtech',
  MASI: 'medtech', ICLR: 'medtech',
  // Semiconductors
  KLAC: 'semis', AMAT: 'semis', ASML: 'semis', ON: 'semis', NXPI: 'semis',
  TER: 'semis', ENTG: 'semis', WOLF: 'semis', AMKR: 'semis', COHR: 'semis',
  CEVA: 'semis', SMTC: 'semis',
  NVDA: 'semis', AMD: 'semis', AVGO: 'semis', ARM: 'semis', MU: 'semis', SMCI: 'semis', TSM: 'semis',
  GFS: 'semis', KEYS: 'semis',
  // Industrials / Infrastructure
  EMR: 'industrial', ROK: 'industrial', NDSN: 'industrial', FELE: 'industrial',
  RBC: 'industrial', AOS: 'industrial', ITT: 'industrial',
  GGG: 'industrial', FLS: 'industrial', IR: 'industrial', AME: 'industrial',
  TRMB: 'industrial', LECO: 'industrial', ZWS: 'industrial',
  GE: 'industrial', CAT: 'industrial', ETN: 'industrial', PH: 'industrial',
  URI: 'industrial', HON: 'industrial', DE: 'industrial',
  HUBB: 'industrial', ODFL: 'industrial', TTEK: 'industrial',
  // Energy / Materials / Mining
  CCJ: 'energy', UEC: 'energy', DNN: 'energy', NXE: 'energy', STNG: 'energy',
  DINO: 'energy', SM: 'energy', PR: 'energy', CTRA: 'energy', EQT: 'energy',
  AR: 'energy', CNX: 'energy',
  XOM: 'energy', SLB: 'energy', EOG: 'energy',
  // Consumer / Retail / Food
  LULU: 'consumer', ONON: 'consumer', CROX: 'consumer', YETI: 'consumer',
  FOXF: 'consumer', BURL: 'consumer', FIVE: 'consumer', BOOT: 'consumer',
  DKS: 'consumer', ANF: 'consumer', AEO: 'consumer',
  WOOF: 'consumer', MNST: 'consumer', COKE: 'consumer',
  CMG: 'consumer', DASH: 'consumer', UBER: 'consumer', LYFT: 'consumer',
  ABNB: 'consumer',
  COST: 'consumer', WMT: 'consumer', NKE: 'consumer', SBUX: 'consumer',
  MCD: 'consumer', PEP: 'consumer',
  DPZ: 'consumer', DKNG: 'consumer', POOL: 'consumer', FND: 'consumer',
};

// --- Generic technical anchors (same across all sectors) ---
// Pure analysis/opinion language: charts, ratings, valuation. NOT earnings outcomes (those are wins/fears).
const TECHNICAL_ANCHORS = [
  'Technical chart pattern signals breakout above resistance level',
  'RSI and MACD indicators suggest bullish momentum building',
  'Valuation metrics show stock trading at discount to peers',
  'Analyst upgrades stock rating to outperform citing fundamentals',
  'Options market positioning suggests elevated implied volatility',
  'Analyst initiates coverage with buy rating and price target',
  'Wall Street raises price target ahead of earnings season',
  'Short interest declines as bearish sentiment reverses on charts',
  'Stock consolidates near support with technical setup improving',
  'Sector rotation into growth names benefits high-beta names',
];

// --- Per-sector macro/abstract fear anchors ---
// Broad industry headwinds, policy threats, macro forces that create negative pressure.
// Distinct from FEAR_ANCHORS (specific company-level threats) by describing sector-wide trends.
const MACRO_FEAR_ANCHORS = {
  defense: [
    'Congressional debate over defense appropriations bill threatens budget cuts across sector',
    'New export controls restrict defense technology sales to allied nations',
    'Military spending backlash grows as political pressure mounts for domestic priorities',
    'Arms control treaty negotiations could limit weapons system development programs',
    'Shifting geopolitical alliances reduce demand for western defense equipment globally',
    'Defense procurement reform initiative threatens to disrupt established contractor relationships',
    'Autonomous weapons ethics debate gains momentum potentially constraining development',
  ],
  biotech: [
    'Healthcare reform legislation could impose drug pricing controls across industry',
    'Patent cliff approaching for blockbuster drugs threatens sector revenue outlook',
    'New regulatory framework tightens clinical trial requirements increasing development costs',
    'Medicare drug price negotiation expansion pressures pharmaceutical industry margins',
    'Anti-pharma political sentiment growing with bipartisan support for pricing restrictions',
    'Generic drug competition intensifying as exclusivity periods expire across therapeutic areas',
    'Clinical trial cost inflation making early stage drug development increasingly uneconomical',
  ],
  cleanenergy: [
    'Fossil fuel lobbying threatens to roll back clean energy subsidy programs',
    'Carbon tax proposal collapse undermines renewable energy investment thesis',
    'Grid infrastructure bottlenecks slow renewable energy deployment nationally',
    'Political backlash against wind and solar projects grows in rural communities',
    'Rare earth material supply concentration creates vulnerability for clean energy sector',
    'Utility rate reform threatens to reduce economics of distributed energy resources',
    'Intermittency challenges erode public and investor confidence in renewable reliability',
  ],
  saas: [
    'Enterprise AI adoption disrupts traditional software business models and pricing',
    'Data privacy regulation forces costly cloud platform architecture redesign',
    'Big tech antitrust action could reshape cloud computing market dynamics',
    'Open source movement challenges proprietary software pricing power across sector',
    'Remote work trend reversal reduces demand for collaboration software tools',
    'Venture capital pullback slows growth investment across software sector',
    'Customer consolidation of vendors reduces total addressable market for niche platforms',
  ],
  cyber: [
    'AI powered threats evolving faster than traditional security defense capabilities',
    'Cybersecurity vendor consolidation pressures smaller specialized companies',
    'International cyber treaty negotiations reshape digital sovereignty requirements',
    'Commoditization of basic security features compresses industry profit margins',
    'Talent shortage across cybersecurity industry constrains growth and innovation',
    'Insurance industry tightening cyber coverage reduces buyer urgency for advanced solutions',
    'Government considering mandated security standards that could disadvantage commercial vendors',
  ],
  fintech: [
    'Banking regulation overhaul threatens to restrict fintech lending operations broadly',
    'Central bank digital currency development could displace private payment networks',
    'Consumer debt crisis raises systemic concerns about buy now pay later model',
    'Interest rate environment shift fundamentally pressures financial services profitability',
    'Regulatory fragmentation across jurisdictions increases compliance burden for sector',
    'Traditional banking lobby pushes for stricter fintech oversight and licensing requirements',
    'Credit tightening cycle threatens to reduce consumer borrowing across lending platforms',
  ],
  medtech: [
    'Medicare reimbursement rate reform threatens medical device industry profitability',
    'Hospital budget constraints drive capital equipment purchase delays sector wide',
    'Regulatory scrutiny of medical device approval pathways increasing globally',
    'Healthcare cost containment pressure forces procedure volume reductions',
    'Supply chain regionalization mandates increase manufacturing costs for device makers',
    'Growing preference for conservative treatment reduces surgical procedure volumes',
    'Medical device tax reinstatement proposal would burden industry margins',
  ],
  semis: [
    'China trade restrictions disrupt semiconductor supply chain globally',
    'Geopolitical tensions over Taiwan threaten chip manufacturing stability worldwide',
    'Export controls on advanced lithography equipment tighten further limiting access',
    'Memory chip market oversupply collapses prices amid weakening consumer demand',
    'Semiconductor cyclical downturn deepens as inventory correction extends across industry',
    'Rising fab construction costs make capacity expansion increasingly capital intensive',
    'End market demand weakness spreading from consumer electronics to industrial applications',
  ],
  industrial: [
    'Trade tariffs on steel and aluminum reshape industrial cost structures broadly',
    'Labor shortage in skilled trades constrains industrial production capacity nationwide',
    'Environmental regulation tightens emissions standards increasing factory compliance costs',
    'Natural disaster disruptions expose fragility of regional manufacturing supply networks',
    'Construction spending slowdown reduces demand for industrial equipment and materials',
    'Energy cost inflation squeezes margins across manufacturing sector',
    'Reshoring incentive uncertainty creates hesitation in domestic capacity investment decisions',
  ],
  energy: [
    'OPEC production decision threatens to collapse oil prices below profitability levels',
    'Rare earth mineral supply chain faces growing geopolitical chokepoint risk',
    'Environmental regulation tightening restricts extraction permits across jurisdictions',
    'Energy transition policies accelerate timeline for fossil fuel demand decline',
    'Mining regulation changes create uncertainty for critical mineral extraction projects',
    'Geopolitical instability in resource-rich regions threatens supply security',
    'Carbon emission liability frameworks expanding could burden energy producers with costs',
  ],
  consumer: [
    'Consumer confidence drops amid inflation and employment uncertainty',
    'Tariffs on imported goods raise retail prices threatening consumer spending power',
    'Generational spending pattern shift away from traditional retail reshapes industry',
    'Minimum wage increase pressures restaurant and retail labor cost structures',
    'Input cost inflation across food and consumer goods squeezes industry margins',
    'Social media driven trend volatility makes consumer brand loyalty increasingly fragile',
    'Discretionary spending pullback as households prioritize essentials over premium products',
  ],
  general: [
    'Trade war escalation threatens supply chain disruption across manufacturing sectors',
    'Federal Reserve tightening policy pressures market sentiment and valuations globally',
    'New government regulation could fundamentally reshape entire industry landscape',
    'Geopolitical tensions drive broad sector volatility across global markets',
    'Antitrust enforcement intensification threatens established business models',
    'Climate policy mandates create uncertain transition costs for affected industries',
    'Global economic slowdown signals spreading across multiple sectors simultaneously',
  ],
};

// --- Per-sector macro/abstract win anchors ---
// Broad industry tailwinds, policy support, macro forces that create positive momentum.
// Distinct from WIN_ANCHORS (specific company-level catalysts) by describing sector-wide trends.
const MACRO_WIN_ANCHORS = {
  defense: [
    'Pentagon budget increase boosts defense contractor spending outlook across sector',
    'NATO allies expand joint military exercises driving demand for interoperable equipment',
    'Space militarization priorities drive sustained satellite defense investment growth',
    'Drone warfare doctrine shift creates expanding procurement opportunities industry wide',
    'Bipartisan defense modernization consensus ensures stable long-term funding environment',
    'Allied nations increasing defense spending commitments toward GDP targets',
    'Military readiness focus drives accelerated equipment replacement cycle globally',
  ],
  biotech: [
    'Global pandemic preparedness initiative accelerates vaccine and therapeutic research funding',
    'Breakthrough therapy regulatory pathways expanding access for innovative treatments',
    'Precision medicine adoption growing as genomic testing costs decline rapidly',
    'Bipartisan support for rare disease research funding increases NIH budget allocations',
    'Aging global population demographics expanding addressable markets for therapeutic areas',
    'Gene therapy manufacturing advances reducing production costs enabling broader access',
    'International regulatory harmonization streamlining multi-market drug approval timelines',
  ],
  cleanenergy: [
    'Climate summit pledges drive renewable energy mandate expansion globally',
    'Grid infrastructure bill advances with bipartisan support for modernization spending',
    'Solar tariff exemptions extended supporting continued deployment cost reductions',
    'Utility scale battery storage deployment accelerating as economics improve rapidly',
    'Corporate renewable energy procurement commitments reaching record levels annually',
    'Green hydrogen production economics improving opening new industrial decarbonization markets',
    'State level renewable portfolio standards ratcheting higher driving sustained demand growth',
  ],
  saas: [
    'Global digital transformation spending accelerating across enterprise and government sectors',
    'Cloud migration trends gaining momentum as organizations modernize legacy infrastructure',
    'AI integration creating new value-added capabilities expanding software pricing power',
    'Small and medium business technology adoption increasing total addressable market',
    'Vertical SaaS opportunities emerging as industry-specific solutions gain traction',
    'Platform ecosystem growth driving higher switching costs and customer retention rates',
    'Government technology modernization mandates opening large new public sector markets',
  ],
  cyber: [
    'Nation state cyber threats escalating driving increased enterprise security budgets',
    'Zero trust architecture becoming mandatory government security standard globally',
    'Ransomware epidemic forcing organizations to dramatically increase cyber defense spending',
    'Cyber insurance requirements driving adoption of advanced security platform capabilities',
    'Regulatory breach disclosure mandates accelerating enterprise security tool procurement',
    'Cloud security spending growing faster than overall IT budgets across industries',
    'Board level cybersecurity oversight requirements elevating security investment priority',
  ],
  fintech: [
    'Cross border payment modernization creating opportunities for innovative platforms',
    'Cryptocurrency regulation clarity enabling institutional adoption and market expansion',
    'Open banking mandates forcing data sharing creating opportunities for fintech platforms',
    'Embedded finance trend expanding addressable market beyond traditional financial services',
    'Financial inclusion initiatives driving adoption of digital banking in underserved markets',
    'Real-time payment infrastructure buildout enabling new commerce and lending models',
    'Wealth management democratization trend expanding retail investment platform adoption',
  ],
  medtech: [
    'Aging population demographics driving sustained surgical robotics demand growth',
    'Global health initiatives expanding access to diagnostic technologies worldwide',
    'New clinical evidence supporting minimally invasive procedures expanding adoption',
    'Healthcare worker shortage accelerating automation and technology adoption in medicine',
    'Value-based care transition rewarding better patient outcomes from advanced devices',
    'Remote patient monitoring reimbursement expansion driving connected health device adoption',
    'Ambulatory surgery center growth creating new distribution channels for device makers',
  ],
  semis: [
    'CHIPS Act funding allocation accelerating domestic fabrication investment growth',
    'AI computing demand surge creating unprecedented semiconductor growth cycle',
    'Automotive electrification driving sustained power semiconductor demand expansion',
    'Edge computing proliferation expanding chip content across connected devices',
    'Data center capacity expansion driving memory and processing demand globally',
    'Industrial automation trend increasing semiconductor content per manufacturing system',
    'National security priority for domestic chip production ensuring sustained government support',
  ],
  industrial: [
    'Infrastructure spending bill allocating billions to construction and modernization projects',
    'Supply chain reshoring trend driving sustained domestic manufacturing expansion',
    'Warehouse automation adoption accelerating amid logistics transformation investment',
    'Water infrastructure upgrade cycle creating multi-year demand for industrial equipment',
    'Electrification of buildings driving HVAC and electrical equipment upgrade cycles',
    'Nearshoring trend creating sustained demand for industrial construction and equipment',
    'Productivity investment priority increasing capital spending on industrial automation',
  ],
  energy: [
    'Nuclear energy policy reversal opening path for new reactor construction globally',
    'Uranium supply deficit widening as reactor fleet expansion accelerates worldwide',
    'Energy security concerns driving strategic reserve and domestic production investment',
    'Critical mineral demand growing as electrification and defense needs expand',
    'Offshore energy development policies creating new exploration and production opportunities',
    'LNG export capacity expansion creating sustained demand for natural gas production',
    'Resource nationalism trends improving pricing power for domestic energy producers',
  ],
  consumer: [
    'Social media driven brand discovery creating rapid growth opportunities for emerging brands',
    'Health and wellness trend expanding premium product categories across consumer segments',
    'Restaurant industry innovation driving same-store sales growth above historical averages',
    'Premiumization trend supporting margin expansion as consumers trade up in categories',
    'International expansion opportunities opening as global middle class spending grows',
    'Direct to consumer channel growth improving brand economics and customer relationships',
    'Experience economy rebound driving spending growth at restaurants and entertainment venues',
  ],
  general: [
    'Federal Reserve easing policy boosting market sentiment and risk appetite broadly',
    'Deregulation initiative reducing compliance costs across multiple industry sectors',
    'Infrastructure investment cycle creating broad economic multiplier effects',
    'Innovation cycle acceleration driving productivity gains across technology-enabled sectors',
    'Capital markets reopening enabling growth investment and strategic transactions',
    'Global trade normalization reducing supply chain costs and improving business predictability',
    'Corporate earnings growth cycle broadening beyond technology sector leadership',
  ],
};

// --- Per-sector "specific fear" anchors ---
// Covers BOTH imminent future threats AND already-happened negative outcomes
// (stock drops, misses estimates, cuts guidance, loses contract, etc.)
const FEAR_ANCHORS = {
  defense: [
    'Stock drops after Pentagon cancels major contract award removing backlog revenue',
    'Defense contractor loses critical program evaluation to rival ending multi-year pursuit',
    'Earnings miss driven by contract delays and cost overruns on key programs',
    'Inspector general investigation freezes company government contracts pending review',
    'Pentagon may cancel next-generation drone contract amid budget sequestration threat',
    'Major ally abandons joint program over cost overruns creating revenue shortfall',
    'Competitor prototype outperforms in evaluation putting billion dollar award at risk',
  ],
  biotech: [
    'FDA rejects drug application sending stock sharply lower on complete response letter',
    'Clinical trial fails to meet primary endpoint forcing program discontinuation',
    'Stock plunges after safety signal forces immediate enrollment halt and program suspension',
    'Earnings miss as drug launch falls far short of prescription forecast expectations',
    'Patent invalidated opening door to generic competition years earlier than expected',
    'FDA advisory committee votes against recommending approval of lead drug candidate',
    'Medicare excludes new therapy from reimbursement devastating commercial launch outlook',
  ],
  cleanenergy: [
    'Stock drops after tariff announcement makes project pipeline economically unviable',
    'Project cancellations accelerate as grid interconnection delays strand committed capacity',
    'Quarterly miss driven by installation shortfalls and deteriorating panel margins',
    'Proposed solar tariff crushes project economics forcing major pipeline write-downs',
    'Fire safety investigation triggers mandatory recall of residential battery systems',
    'Project financing costs surge as lenders reassess renewable energy credit risk',
    'State utility commission reverses net metering policy devastating rooftop solar economics',
  ],
  saas: [
    'Stock drops after reporting customer churn spike and disappointing new bookings',
    'Earnings miss as major enterprise customer terminates contract migrating to competitor',
    'Revenue growth decelerates sharply as economic downturn forces enterprise budget cuts',
    'Customer concentration risk realized as largest account reduces spending significantly',
    'Open source alternative gaining rapid adoption threatening to commoditize core product',
    'Net revenue retention falls below one hundred percent signaling customer contraction',
    'Data breach triggers regulatory investigation and customer cancellation wave',
  ],
  cyber: [
    'Stock plunges after major customer breach despite deployed product damages credibility',
    'Zero day vulnerability in flagship product exploited in widespread attack campaign',
    'Earnings miss driven by deal slippage and elongating enterprise sales cycles',
    'Government certification suspended after audit reveals compliance gaps in product',
    'Stock drops as customer fails to renew large platform contract citing budget constraints',
    'Competitor free tier gaining rapid adoption threatening to commoditize core product',
    'Nation state actor develops bypass for company detection technology undermining value',
  ],
  fintech: [
    'Stock drops after reporting rising default rates and deteriorating credit quality',
    'Regulatory enforcement action announced for alleged consumer lending violations',
    'Earnings miss driven by credit losses accelerating beyond management guidance',
    'Banking partner terminates sponsorship agreement cutting off payment processing access',
    'Fraud losses accelerate faster than revenue growth destroying unit economics',
    'Rising default rates trigger covenant breach concern and capital adequacy questions',
    'State attorney general launches investigation into fee practices threatening penalties',
  ],
  medtech: [
    'Stock drops after FDA warning letter forces production halt at primary facility',
    'Earnings miss driven by weak surgical procedure volumes and hospital budget constraints',
    'Competitor device shows superior outcomes in head-to-head clinical trial versus company',
    'Class action lawsuit filed alleging device malfunction causing serious patient injuries',
    'Medicare reimbursement rate cut makes procedure economically unviable for hospitals',
    'Post-market data reveals higher than expected adverse event rates triggering review',
    'Key surgeon advocates withdraw endorsement citing long-term device safety concerns',
  ],
  semis: [
    'Stock plunges after reporting inventory correction is deeper and longer than expected',
    'Earnings miss as end market demand falls sharply below management guidance forecasts',
    'Major OEM switches to rival chip supplier ending multi-year design win relationship',
    'Export ban expansion cuts off major data center customer destroying revenue outlook',
    'Yield issues at new process node delay production ramp by multiple quarters',
    'Inventory correction accelerates as end market demand falls sharply below forecasts',
    'Stock drops on weak guidance citing softening demand across key end markets',
  ],
  industrial: [
    'Stock drops after major infrastructure contract cancellation eliminates backlog revenue',
    'Earnings miss driven by raw material cost surge and margin compression on fixed contracts',
    'Labor strike at primary manufacturing plant halts production creating delivery shortfalls',
    'OSHA investigation after workplace incident results in facility shutdown order',
    'Key distributor drops product line in favor of lower-cost competitor alternatives',
    'Supply chain bottleneck forces inability to meet committed customer delivery schedules',
    'Environmental compliance failure results in substantial fines and remediation costs',
  ],
  energy: [
    'Stock drops on commodity price collapse below breakeven forcing production curtailment',
    'Earnings miss driven by weak commodity prices and disappointing production volumes',
    'Drilling moratorium strands significant proved reserve assets reducing valuation',
    'Environmental disaster investigation triggers license revocation and cleanup liability',
    'Foreign government nationalizes mining assets revoking operating concessions',
    'Pipeline permit rejected leaving production capacity without takeaway route',
    'Commodity price collapse threatens viability of high-cost production assets',
  ],
  consumer: [
    'Stock drops after reporting same-store sales miss and cutting full-year guidance',
    'Product recall announced after contamination reports surface across multiple markets',
    'Earnings miss driven by traffic declines and margin compression from input costs',
    'Viral social media backlash causes lasting brand damage and consumer boycott',
    'Key retail partner reduces shelf space allocation hurting volume and visibility',
    'Celebrity partnership dissolution triggers significant sales decline in key demographic',
    'Input cost inflation forces price increases that drive material volume decline',
  ],
  general: [
    'Stock plunges after reporting earnings miss and cutting full-year revenue guidance',
    'Company misses estimates with weaker than expected margins and cash generation',
    'Major customer contract loss creates significant revenue gap in forward outlook',
    'Regulatory investigation results in substantial fines and operational restrictions',
    'Key executive departure disrupts critical ongoing strategic initiative execution',
    'Credit rating downgraded increasing borrowing costs and limiting financing access',
    'Lawsuit verdict delivers material financial liability exceeding reserve estimates',
  ],
};

// --- Per-sector "specific win" anchors ---
// Covers BOTH imminent future catalysts AND already-happened positive outcomes
// (stock jumps, beats estimates, secures contract, reports record revenue, etc.)
const WIN_ANCHORS = {
  defense: [
    'Stock jumps after securing major Pentagon contract award beating competitors',
    'Defense contractor wins sole-source position on critical modernization program',
    'Earnings beat driven by strong defense program execution and record backlog',
    'Company reports record revenue from classified program ramp ahead of schedule',
    'Allied nation finalizes major weapons purchase agreement boosting outlook',
    'Pentagon expected to award next-generation drone contract worth billions this quarter',
    'Foreign military sales approval imminent for advanced weapons system export',
    'Stock surges on news of unexpected contract expansion and scope increase',
  ],
  biotech: [
    'FDA approves drug candidate sending stock sharply higher on approval news',
    'Clinical trial results show superior efficacy beating placebo with strong p-value',
    'Drug receives breakthrough therapy designation accelerating regulatory timeline',
    'Stock jumps after positive interim data from pivotal trial exceeds expectations',
    'Major pharmaceutical company exercises option on licensing deal at premium valuation',
    'FDA advisory committee votes to recommend approval of lead drug candidate',
    'Pivotal trial results due soon with interim data suggesting strong efficacy signal',
    'Earnings beat driven by blockbuster drug launch exceeding prescription forecasts',
  ],
  cleanenergy: [
    'Company wins major utility contract securing multi-year revenue visibility',
    'Stock surges after grid interconnection approval for large-scale solar project',
    'Project financing secured at favorable terms enabling accelerated capacity buildout',
    'Quarterly results beat on strong installation volumes and improving margins',
    'Federal incentive extension drives accelerated project pipeline deployment',
    'New technology breakthrough dramatically improves panel efficiency ahead of competitors',
    'Strategic partnership with major energy company announced boosting growth outlook',
    'Stock rallies on record project pipeline and improving unit economics',
  ],
  saas: [
    'Earnings beat estimates with accelerating revenue growth and improving margins',
    'Stock jumps on record net revenue retention and strong new customer additions',
    'Major enterprise customer expands contract significantly exceeding expectations',
    'New product launch drives exceptional early adoption and pipeline acceleration',
    'Platform selected as standard by major government agency for enterprise deployment',
    'Customer retention metrics reach record highs signaling durable competitive moat',
    'AI feature integration drives measurable uplift in customer spending and upsell',
    'Stock rallies after reporting record free cash flow and raised full-year guidance',
  ],
  cyber: [
    'Stock surges after reporting record bookings and strong new customer acquisition',
    'Major federal agency contract win validates platform against competitive field',
    'Earnings beat driven by platform consolidation and multi-product upsell success',
    'New threat detection capability outperforms rivals in independent testing evaluation',
    'Zero trust mandate drives accelerated enterprise adoption ahead of compliance deadline',
    'Strategic partnership with cloud hyperscaler expands distribution significantly',
    'Stock jumps on strong quarterly results with raising of full-year guidance',
    'Company reports record annual recurring revenue growth beating analyst estimates',
  ],
  fintech: [
    'Stock surges after reporting strong loan origination growth and improving credit quality',
    'Banking charter approved unlocking deposit funding and margin expansion opportunity',
    'Earnings beat driven by record transaction volumes and expanding net interest margin',
    'Major payment network partnership announced expanding merchant reach significantly',
    'Credit performance improves faster than expected with loss rates declining sharply',
    'Stock jumps on record payment volume and stronger than expected revenue growth',
    'Regulatory clarity on digital assets accelerates institutional adoption momentum',
    'New market expansion generates strong early traction with record first-quarter results',
  ],
  medtech: [
    'FDA clears next-generation device with expanded indications boosting addressable market',
    'Earnings beat driven by strong surgical procedure volumes and robust device placements',
    'Stock jumps after landmark clinical trial results show superior patient outcomes',
    'Major hospital system contract win drives significant revenue growth acceleration',
    'New reimbursement code approval dramatically improves procedure economics',
    'International regulatory approval opens large new addressable market ahead of schedule',
    'Stock surges on record procedure volumes and raising of full-year earnings guidance',
    'Post-market data shows exceptional outcomes strengthening competitive positioning',
  ],
  semis: [
    'Stock jumps after reporting record data center chip revenue beating estimates',
    'Major design win secured with leading hyperscaler for next-generation AI chip',
    'Earnings beat driven by AI chip demand surge with raised full-year guidance',
    'Data center win with mystery hyperscaler boosts revenue outlook significantly',
    'Company reports record quarterly revenue from automotive and AI chip ramp',
    'Key customer qualification complete enabling volume production ramp this quarter',
    'Stock surges on strong demand signals and expanding data center market share',
    'Inventory correction ends with restocking cycle driving better than expected results',
  ],
  industrial: [
    'Stock surges after winning major infrastructure contract exceeding analyst expectations',
    'Earnings beat driven by record order backlog and strong pricing power execution',
    'Company reports record revenue from reshoring-driven domestic manufacturing demand',
    'Major customer expands purchase commitments citing superior product performance',
    'Strategic acquisition closes creating significant cost synergy ahead of schedule',
    'New product line gains rapid market share with margin-accretive pricing success',
    'Stock jumps on record backlog and raising of full-year revenue guidance',
    'Automation technology deployment delivers record throughput improvement results',
  ],
  energy: [
    'Exploration results confirm significantly larger resource than initial estimates',
    'Stock jumps on record production volumes and improving commodity price realization',
    'Long-term offtake agreement signed securing favorable pricing for future output',
    'Earnings beat driven by strong commodity prices and better than expected volumes',
    'Production permit approved unlocking substantial proved reserve development',
    'Strategic joint venture accelerates development timeline ahead of schedule',
    'New extraction technology reduces costs well below industry average breakeven',
    'Stock rallies on record cash flow generation and increased shareholder return program',
  ],
  consumer: [
    'Stock jumps after reporting record same-store sales growth and raised guidance',
    'Viral product drives exceptional demand with record sell-through at retail partners',
    'Earnings beat driven by strong volume growth and premium pricing success',
    'Major retail chain expansion adds significant new store distribution this quarter',
    'Celebrity brand partnership drives substantial awareness and record trial conversion',
    'International market entry generates strong early consumer reception and reorders',
    'Premium pricing strategy succeeds with consumers trading up despite conditions',
    'Stock surges on record restaurant traffic and expanding restaurant margins',
  ],
  general: [
    'Stock jumps after reporting record quarterly revenue and raising full-year guidance',
    'Earnings beat estimates with stronger than expected margins and cash generation',
    'Major contract win creates significant new revenue stream beating analyst models',
    'Strategic acquisition closes with better than expected synergy realization pace',
    'New product launch exceeds early adoption targets with strong customer feedback',
    'Regulatory approval received unlocking substantial new market opportunity',
    'Stock surges on record results and management raising earnings per share outlook',
    'Credit rating upgraded reducing financing costs and improving capital structure',
  ],
};

const SIMILARITY_THRESHOLD = 0.015;

// Module-level cache: { sector: Float64Array[] }
let cachedTechnicalEmb = null;
let cachedFearEmb = {}; // keyed by sector
let cachedWinEmb = {}; // keyed by sector
let cachedMacroFearEmb = {}; // keyed by sector
let cachedMacroWinEmb = {}; // keyed by sector

/**
 * Ensure technical anchor embeddings are loaded (one-time)
 */
async function ensureTechnicalAnchors() {
  if (cachedTechnicalEmb) return cachedTechnicalEmb;
  console.log('[NewsClassifier] Computing technical anchor embeddings...');
  cachedTechnicalEmb = await embeddingService.embedBatch(
    TECHNICAL_ANCHORS.map(t => `title: technical analysis headline | text: ${t}`),
    { showProgress: false }
  );
  return cachedTechnicalEmb;
}

/**
 * Ensure fear anchor embeddings are loaded for a given sector
 */
async function ensureFearAnchors(sector) {
  if (cachedFearEmb[sector]) return cachedFearEmb[sector];
  const anchors = FEAR_ANCHORS[sector] || FEAR_ANCHORS.general;
  cachedFearEmb[sector] = await embeddingService.embedBatch(
    anchors.map(t => `title: specific future risk headline | text: ${t}`),
    { showProgress: false }
  );
  return cachedFearEmb[sector];
}

/**
 * Ensure win anchor embeddings are loaded for a given sector
 */
async function ensureWinAnchors(sector) {
  if (cachedWinEmb[sector]) return cachedWinEmb[sector];
  const anchors = WIN_ANCHORS[sector] || WIN_ANCHORS.general;
  cachedWinEmb[sector] = await embeddingService.embedBatch(
    anchors.map(t => `title: specific future catalyst headline | text: ${t}`),
    { showProgress: false }
  );
  return cachedWinEmb[sector];
}

/**
 * Ensure macro fear anchor embeddings are loaded for a given sector
 */
async function ensureMacroFearAnchors(sector) {
  if (cachedMacroFearEmb[sector]) return cachedMacroFearEmb[sector];
  const anchors = MACRO_FEAR_ANCHORS[sector] || MACRO_FEAR_ANCHORS.general;
  cachedMacroFearEmb[sector] = await embeddingService.embedBatch(
    anchors.map(t => `title: macro industry headwind headline | text: ${t}`),
    { showProgress: false }
  );
  return cachedMacroFearEmb[sector];
}

/**
 * Ensure macro win anchor embeddings are loaded for a given sector
 */
async function ensureMacroWinAnchors(sector) {
  if (cachedMacroWinEmb[sector]) return cachedMacroWinEmb[sector];
  const anchors = MACRO_WIN_ANCHORS[sector] || MACRO_WIN_ANCHORS.general;
  cachedMacroWinEmb[sector] = await embeddingService.embedBatch(
    anchors.map(t => `title: macro industry tailwind headline | text: ${t}`),
    { showProgress: false }
  );
  return cachedMacroWinEmb[sector];
}

/**
 * Compute max cosine similarity of an embedding against a set of anchor embeddings.
 * Max is better than average: a headline that strongly matches one anchor should win,
 * not be diluted by weaker anchors in the same category.
 */
function maxSimilarity(embedding, anchors) {
  let best = -Infinity;
  for (const anchor of anchors) {
    const s = embeddingService.cosineSimilarity(embedding, anchor);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Classify a single headline embedding
 * 5-way: technical, fear (specific), win (specific), macro_fear (abstract), macro_win (abstract)
 */
function classifySingle(headlineEmb, techAnchors, fearAnchors, winAnchors, macroFearAnchors, macroWinAnchors) {
  const techSim = maxSimilarity(headlineEmb, techAnchors);
  const fearSim = maxSimilarity(headlineEmb, fearAnchors);
  const winSim = maxSimilarity(headlineEmb, winAnchors);
  const macroFearSim = maxSimilarity(headlineEmb, macroFearAnchors);
  const macroWinSim = maxSimilarity(headlineEmb, macroWinAnchors);

  const sims = { technical: techSim, fear: fearSim, win: winSim, macro_fear: macroFearSim, macro_win: macroWinSim };
  const sorted = Object.entries(sims).sort((a, b) => b[1] - a[1]);
  const diff = sorted[0][1] - sorted[1][1];

  if (diff < SIMILARITY_THRESHOLD) {
    return { category: 'mixed', confidence: diff, ...sims };
  }
  return { category: sorted[0][0], confidence: diff, ...sims };
}

/**
 * Classify news headlines for all tickers after screening.
 * Uses headline text only (no article extraction).
 * Mutates each entry.news[] adding .category in place.
 *
 * @param {Array} allTickers - The allTickers array from screenTickers()
 */
async function classifyTickerNews(allTickers) {
  // Collect all news items with their ticker context
  const items = []; // { tickerIdx, newsIdx, headline, sector }
  for (let ti = 0; ti < allTickers.length; ti++) {
    const entry = allTickers[ti];
    if (!entry.news || entry.news.length === 0) continue;
    const sector = SECTOR_MAP[entry.ticker] || 'general';
    for (let ni = 0; ni < entry.news.length; ni++) {
      const n = entry.news[ni];
      if (n.headline) {
        items.push({ tickerIdx: ti, newsIdx: ni, headline: n.headline, sector });
      }
    }
  }

  if (items.length === 0) return;

  const tickerCount = new Set(items.map(i => allTickers[i.tickerIdx].ticker)).size;
  console.log(`[NewsClassifier] Classifying ${items.length} headlines across ${tickerCount} tickers...`);

  // Ensure technical anchors are loaded
  const techAnchors = await ensureTechnicalAnchors();

  // Ensure per-sector anchors are loaded
  const sectors = [...new Set(items.map(i => i.sector))];
  console.log(`[NewsClassifier] Sectors: ${sectors.join(', ')}`);
  for (const sector of sectors) {
    await ensureFearAnchors(sector);
    await ensureWinAnchors(sector);
    await ensureMacroFearAnchors(sector);
    await ensureMacroWinAnchors(sector);
  }

  // Embed all headlines
  const embTexts = items.map(item => `title: news headline | text: ${item.headline}`);
  const embeddings = await embeddingService.embedBatch(embTexts, { showProgress: false });

  // Classify each and write back
  let counts = { technical: 0, fear: 0, win: 0, macro_fear: 0, macro_win: 0, mixed: 0 };
  for (let i = 0; i < items.length; i++) {
    const { tickerIdx, newsIdx, sector } = items[i];
    const fearAnchors = cachedFearEmb[sector];
    const winAnchors = cachedWinEmb[sector];
    const macroFearAnchors = cachedMacroFearEmb[sector];
    const macroWinAnchors = cachedMacroWinEmb[sector];
    const result = classifySingle(embeddings[i], techAnchors, fearAnchors, winAnchors, macroFearAnchors, macroWinAnchors);
    allTickers[tickerIdx].news[newsIdx].category = result.category;
    counts[result.category]++;
  }

  console.log(`[NewsClassifier] Done: ${counts.technical} technical, ${counts.fear} fear, ${counts.win} win, ${counts.macro_fear} macro-fear, ${counts.macro_win} macro-win, ${counts.mixed} mixed`);
}

// ── Event tag embeddings ─────────────────────────────────────────────────
// One Float64Array[] per tag id, computed lazily on first call.
const cachedTagAnchorEmb = {};

async function ensureTagAnchors(tag) {
  if (cachedTagAnchorEmb[tag.id]) return cachedTagAnchorEmb[tag.id];
  cachedTagAnchorEmb[tag.id] = await embeddingService.embedBatch(
    tag.anchors.map(t => `title: news headline | text: ${t}`),
    { showProgress: false }
  );
  return cachedTagAnchorEmb[tag.id];
}

/**
 * Score per-ticker event tags from headlines.
 *
 * For each ticker, embeds its headlines once and scores each headline against
 * every applicable tag's anchor set. A tag fires if any headline's max
 * cosine-similarity against that tag's anchors meets the tag threshold.
 *
 * Mutates each entry, adding:
 *   - entry.eventTags: string[]                   (ordered by best score desc)
 *   - entry.eventTagEvidence: {tagId: {headline, score}}
 *
 * @param {Array} allTickers
 */
async function tagTickerEvents(allTickers) {
  // Gather (ticker, headline) pairs.
  const items = [];
  for (let ti = 0; ti < allTickers.length; ti++) {
    const entry = allTickers[ti];
    if (!entry.news || entry.news.length === 0) continue;
    for (let ni = 0; ni < entry.news.length; ni++) {
      const h = entry.news[ni].headline;
      if (h) items.push({ tickerIdx: ti, headline: h });
    }
  }
  if (items.length === 0) return;

  // Pre-load all tag anchor embeddings up front.
  for (const tag of EVENT_TAGS) await ensureTagAnchors(tag);

  // Embed all headlines in one batch.
  const embTexts = items.map(it => `title: news headline | text: ${it.headline}`);
  const embeddings = await embeddingService.embedBatch(embTexts, { showProgress: false });

  // For each ticker, find tags whose any-headline score >= threshold.
  // Best-headline tracked per (ticker, tag) so we can surface evidence.
  const perTicker = new Map(); // tickerIdx -> { tagId: {score, headline} }

  for (let i = 0; i < items.length; i++) {
    const { tickerIdx, headline } = items[i];
    const emb = embeddings[i];
    const sector = SECTOR_MAP[allTickers[tickerIdx].ticker] || 'general';

    for (const tag of EVENT_TAGS) {
      if (!tagApplies(tag, sector)) continue;
      const anchors = cachedTagAnchorEmb[tag.id];
      const score = maxSimilarity(emb, anchors);
      if (score < tag.threshold) continue;

      let bag = perTicker.get(tickerIdx);
      if (!bag) { bag = {}; perTicker.set(tickerIdx, bag); }
      const prev = bag[tag.id];
      if (!prev || score > prev.score) {
        bag[tag.id] = { score, headline };
      }
    }
  }

  // Keep only the top-K tags per ticker (highest score wins).
  // Multiple loosely-matching tags clutter the report; the strongest 1–2 are
  // what's actionable.
  const MAX_TAGS_PER_TICKER = 2;
  let totalTags = 0;
  for (const [tickerIdx, bag] of perTicker.entries()) {
    const ordered = Object.entries(bag)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_TAGS_PER_TICKER);
    allTickers[tickerIdx].eventTags = ordered.map(([id]) => id);
    allTickers[tickerIdx].eventTagEvidence = Object.fromEntries(
      ordered.map(([id, ev]) => [id, { headline: ev.headline, score: Math.round(ev.score * 1000) / 1000 }])
    );
    totalTags += ordered.length;
  }
  console.log(`[NewsClassifier] Event tags: ${totalTags} fired across ${perTicker.size} tickers`);
}

module.exports = { classifyTickerNews, tagTickerEvents, SECTOR_MAP };
