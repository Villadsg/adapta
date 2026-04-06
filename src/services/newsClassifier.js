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
const TECHNICAL_ANCHORS = [
  'Stock price target raised by analysts to new high',
  'Technical chart pattern signals breakout above resistance',
  'Earnings beat estimates with revenue growth acceleration',
  'RSI and MACD indicators suggest bullish momentum',
  'Valuation metrics show stock trading at discount to peers',
  'Quarterly results exceed Wall Street consensus expectations',
  'Analyst upgrades stock rating to outperform on fundamentals',
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

// --- Per-sector "specific future fear" anchors ---
// Captures news describing a specific bad outcome likely in the near future.
// Distinct from narrative (macro forces/trends) by focusing on imminent, concrete threats.
const FEAR_ANCHORS = {
  defense: [
    'Pentagon may cancel next-generation drone contract amid budget sequestration threat',
    'Key defense supplier faces imminent security clearance revocation jeopardizing programs',
    'Congressional committee threatens to block export license for critical weapons system',
    'Major ally reportedly planning to abandon joint fighter program over cost overruns',
    'Inspector general investigation could freeze company government contracts for months',
    'Competitor prototype outperforms in evaluation putting billion dollar award at risk',
    'Cyberattack on defense contractor may have compromised classified program data',
  ],
  biotech: [
    'FDA likely to issue complete response letter rejecting lead drug candidate application',
    'Clinical trial safety signal could force immediate enrollment halt and program suspension',
    'Patent challenge ruling expected soon threatens to invalidate core drug franchise protection',
    'Key opinion leader publicly questions efficacy data ahead of advisory committee vote',
    'Manufacturing contamination at sole production facility risks extended supply disruption',
    'Competitor readout expected to show superior results threatening market share loss',
    'Medicare coverage determination may exclude new therapy from reimbursement eligibility',
  ],
  cleanenergy: [
    'Proposed tariff on imported solar panels could make projects economically unviable',
    'Grid interconnection delays threaten to strand billions in committed renewable capacity',
    'Key battery material supplier warns of potential force majeure disrupting deliveries',
    'State utility commission may reverse net metering policy devastating rooftop solar economics',
    'Fire safety investigation could trigger mandatory recall of residential battery systems',
    'Project financing costs surging as lenders reassess renewable energy credit risk',
    'Permitting moratorium on wind farms expected to halt new development pipeline',
  ],
  saas: [
    'Major enterprise customer preparing to terminate contract and migrate to competitor platform',
    'Data breach investigation may reveal customer information exposure triggering liability',
    'Proposed regulation would ban cross-border data transfers threatening international revenue',
    'Key integration partner planning to build competing native functionality next quarter',
    'Engineering team attrition accelerating with critical product launch deadline approaching',
    'Open source alternative gaining rapid adoption threatening to commoditize core product',
    'Customer churn rate spiking as economic downturn forces enterprise software budget cuts',
  ],
  cyber: [
    'Zero day vulnerability discovered in flagship product could enable widespread exploitation',
    'Government certification renewal at risk after audit reveals compliance gaps',
    'Major customer breach despite deployed security product threatens credibility and renewals',
    'Competitor offering free tier that directly targets company core customer segment',
    'Pending legislation could mandate vendor liability for breaches undermining business model',
    'Key technology partnership dissolution would remove critical threat intelligence data source',
    'Nation state actor reportedly developing bypass for company primary detection technology',
  ],
  fintech: [
    'Regulatory enforcement action expected for alleged consumer lending violations',
    'Banking partner may terminate sponsorship agreement cutting off payment processing access',
    'Rising default rates on loan portfolio could trigger covenant breach and capital call',
    'State attorney general investigation into fee practices threatens multi-state penalties',
    'Card network rule change would significantly increase interchange costs for platform',
    'Fraud losses accelerating faster than revenue growth threatening unit economics viability',
    'Proposed interest rate cap legislation would eliminate profitability of core lending product',
  ],
  medtech: [
    'FDA warning letter could force production halt at primary manufacturing facility',
    'Class action lawsuit alleges device malfunction causing patient injuries',
    'Medicare reimbursement rate cut proposal would make procedure economically unviable',
    'Competitor device shows superior outcomes in head-to-head clinical trial results',
    'Supply chain disruption threatens inability to fulfill hospital purchase orders',
    'Post-market surveillance data reveals higher than expected adverse event rates',
    'Key surgeon advocate withdraws endorsement citing concerns about long-term device safety',
  ],
  semis: [
    'Commerce Department preparing expanded export ban that would cut off major chip customer',
    'Key foundry partner warns of potential fab shutdown due to contamination risk',
    'Major smartphone OEM reportedly considering switching to rival chip supplier next quarter',
    'Yield issues at new process node could delay production ramp by multiple quarters',
    'Trade restrictions may block access to critical lithography equipment for fab expansion',
    'Inventory correction accelerating as end market demand falls sharply below forecasts',
    'Customer design win loss to competitor threatens multi-year revenue stream',
  ],
  industrial: [
    'Major infrastructure project cancellation would eliminate significant backlog revenue',
    'Raw material cost surge threatens to erase margins on fixed-price contracts',
    'OSHA investigation after workplace incident could result in facility shutdown order',
    'Key distributor planning to drop product line in favor of lower-cost competitor',
    'Supply chain bottleneck threatens inability to meet committed delivery schedules',
    'Environmental compliance failure risks substantial fines and remediation costs',
    'Labor strike authorization vote at primary manufacturing plant expected this week',
  ],
  energy: [
    'Proposed drilling moratorium would strand significant proved reserve assets',
    'Pipeline permit rejection threatens to leave production capacity without takeaway route',
    'Environmental disaster investigation could result in license revocation and cleanup liability',
    'Foreign government threatens to nationalize mining assets and revoke concessions',
    'Uranium supply contract counterparty at risk of default on delivery obligations',
    'Regulatory change could reclassify key resource as hazardous restricting extraction',
    'Commodity price collapse below breakeven threatens forced production curtailment',
  ],
  consumer: [
    'Product recall imminent after contamination reports surface across multiple markets',
    'Viral social media backlash threatens lasting brand damage and consumer boycott',
    'Key retail partner planning to reduce shelf space allocation next quarter',
    'Input cost inflation expected to force price increases risking volume decline',
    'Whistleblower complaint alleges food safety violations at primary production facility',
    'Celebrity partnership dissolution could trigger significant sales decline in key demographic',
    'Proposed tariff on imported ingredients would substantially increase cost of goods sold',
  ],
  general: [
    'Company facing imminent risk of debt covenant breach and potential default',
    'Regulatory investigation could result in substantial fines and operational restrictions',
    'Key executive departure threatens to disrupt critical ongoing strategic initiative',
    'Major customer contract loss would create significant revenue gap next quarter',
    'Supply chain failure risks inability to meet near-term demand commitments',
    'Lawsuit verdict expected soon with potential for material financial liability',
    'Credit rating downgrade warning could increase borrowing costs and limit financing',
  ],
};

// --- Per-sector "specific future win" anchors ---
// Captures news describing a specific positive outcome likely in the near future.
// Distinct from narrative (macro forces/trends) by focusing on imminent, concrete catalysts.
const WIN_ANCHORS = {
  defense: [
    'Pentagon expected to award next-generation drone contract worth billions this quarter',
    'Allied nation finalizing major weapons purchase agreement with defense contractor',
    'Company prototype reportedly outperforming rivals in critical evaluation trial',
    'Congressional committee signals strong bipartisan support for expanded defense budget',
    'New classified program contract expected to be announced within weeks',
    'Defense contractor secures sole-source position on critical modernization program',
    'Foreign military sales approval imminent for advanced weapons system export',
  ],
  biotech: [
    'FDA advisory committee expected to recommend approval of lead drug candidate',
    'Pivotal trial results due soon with interim data suggesting strong efficacy signal',
    'Breakthrough therapy designation accelerates path to near-term drug approval',
    'Major pharmaceutical partner likely to exercise option on licensing deal',
    'Patent portfolio strengthened with key ruling expected to block generic competition',
    'Expanded indication filing could double addressable patient population this year',
    'Priority review voucher accelerates regulatory timeline for flagship treatment',
  ],
  cleanenergy: [
    'Major utility contract award expected to secure multi-year revenue visibility',
    'Federal incentive extension likely to accelerate project pipeline deployment',
    'Grid interconnection approval imminent for large-scale solar and storage project',
    'Strategic partnership with major energy company expected to be announced soon',
    'New technology breakthrough dramatically improves panel efficiency ahead of competitors',
    'State renewable portfolio standard increase expected to drive demand surge',
    'Project financing secured at favorable terms enabling accelerated capacity buildout',
  ],
  saas: [
    'Major enterprise customer expected to expand contract significantly this quarter',
    'New product launch generating exceptional early adoption and pipeline growth',
    'Strategic acquisition target identified that would accelerate platform capabilities',
    'Key industry analyst expected to upgrade rating citing accelerating growth metrics',
    'Platform selected as standard by major government agency for enterprise deployment',
    'Customer retention metrics reaching record highs signaling durable competitive moat',
    'AI feature integration driving measurable uplift in customer engagement and upsell',
  ],
  cyber: [
    'Major federal agency contract award expected after successful evaluation period',
    'New threat detection capability demonstrates superior performance in independent testing',
    'Zero trust mandate driving accelerated enterprise adoption ahead of compliance deadline',
    'Strategic partnership with cloud hyperscaler expected to expand distribution significantly',
    'Industry certification achievement positions company for expanded government opportunities',
    'Managed detection service gaining rapid enterprise traction with strong unit economics',
    'Platform consolidation trend driving multi-product adoption among existing customers',
  ],
  fintech: [
    'Banking charter approval expected to unlock deposit funding and margin expansion',
    'Major payment network partnership announcement imminent expanding merchant reach',
    'Regulatory clarity on digital assets expected to accelerate institutional adoption',
    'Credit performance improving faster than expected with loss rates declining sharply',
    'New market expansion into high-growth geography generating strong early traction',
    'Embedded finance partnership with major retailer expected to drive transaction volume',
    'Interest rate environment shift expected to significantly boost net interest margin',
  ],
  medtech: [
    'FDA clearance expected for next-generation device with expanded clinical indications',
    'Landmark clinical trial results due showing potential for superior patient outcomes',
    'Major hospital system contract award expected to drive significant revenue growth',
    'New reimbursement code approval would dramatically improve procedure economics',
    'Robotic surgery platform adoption accelerating with new surgeon training pipeline',
    'International regulatory approval imminent opening large new addressable market',
    'Post-market data showing exceptional outcomes likely to strengthen competitive position',
  ],
  semis: [
    'Major design win secured with leading smartphone OEM for next-generation chip',
    'New process node yield improvements ahead of schedule enabling accelerated ramp',
    'Data center AI chip demand driving capacity expansion with customer prepayments',
    'Strategic fab partnership expected to secure supply and reduce concentration risk',
    'Key customer qualification complete positioning for volume production ramp',
    'Inventory correction nearing bottom with restocking cycle expected to begin soon',
    'Automotive design win pipeline converting to production revenue this quarter',
  ],
  industrial: [
    'Major infrastructure project award expected to significantly expand order backlog',
    'New product line gaining rapid market share with margin accretive pricing',
    'Strategic acquisition expected to close creating significant cost synergy opportunity',
    'Key customer expanding purchase commitments citing superior product performance',
    'Reshoring trend driving domestic manufacturing facility expansion ahead of schedule',
    'Pricing power demonstrating ability to pass through cost increases with margin expansion',
    'Automation technology deployment reducing production costs and improving throughput',
  ],
  energy: [
    'Exploration results indicate significantly larger resource than initial estimates',
    'Production permit approval expected to unlock substantial proved reserve development',
    'Long-term offtake agreement imminent securing favorable pricing for output',
    'Strategic joint venture with major operator expected to accelerate development timeline',
    'Commodity price surge above breakeven dramatically improving cash flow outlook',
    'Government strategic reserve purchase program expected to support sustained demand',
    'New extraction technology breakthrough reducing costs well below industry average',
  ],
  consumer: [
    'Viral product trend driving exceptional demand ahead of quarterly earnings report',
    'Major retail chain expansion adding significant new store distribution this quarter',
    'Celebrity brand partnership launch expected to drive substantial awareness and trial',
    'Menu innovation driving same-store sales acceleration above industry growth rates',
    'International market entry generating strong early consumer reception and reorder rates',
    'Premium pricing strategy succeeding with consumers trading up despite market conditions',
    'Health and wellness trend alignment positioning brand for sustained demand growth',
  ],
  general: [
    'Major contract award expected to create significant new revenue stream next quarter',
    'Strategic acquisition closing soon with strong expected synergy realization',
    'New product launch exceeding early adoption targets with strong customer feedback',
    'Regulatory approval imminent that would unlock substantial market opportunity',
    'Credit rating upgrade expected to reduce financing costs and improve capital access',
    'Key partnership agreement about to be finalized expanding addressable market',
    'Operational improvement initiative delivering better than expected margin expansion',
  ],
};

const SIMILARITY_THRESHOLD = 0.03;

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
 * Compute average cosine similarity of an embedding against a set of anchor embeddings
 */
function avgSimilarity(embedding, anchors) {
  let sum = 0;
  for (const anchor of anchors) {
    sum += embeddingService.cosineSimilarity(embedding, anchor);
  }
  return sum / anchors.length;
}

/**
 * Classify a single headline embedding
 * 5-way: technical, fear (specific), win (specific), macro_fear (abstract), macro_win (abstract)
 */
function classifySingle(headlineEmb, techAnchors, fearAnchors, winAnchors, macroFearAnchors, macroWinAnchors) {
  const techSim = avgSimilarity(headlineEmb, techAnchors);
  const fearSim = avgSimilarity(headlineEmb, fearAnchors);
  const winSim = avgSimilarity(headlineEmb, winAnchors);
  const macroFearSim = avgSimilarity(headlineEmb, macroFearAnchors);
  const macroWinSim = avgSimilarity(headlineEmb, macroWinAnchors);

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

module.exports = { classifyTickerNews, SECTOR_MAP };
