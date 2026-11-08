import type { AgentKey, BusinessType, FaqDef, SequenceDef, ServiceDef, WeeklyHours } from '../types';

/**
 * Business-type templates. Used to SEED the `business_templates` table; at
 * runtime onboarding reads the (admin-editable) database copy.
 *
 * Template content is written in English. The owner edits it during
 * onboarding; per-language overrides can be added under `i18n` without code
 * changes.
 */
export interface BusinessTemplate {
  type: BusinessType;
  /** Placeholder business name used until the owner types one. */
  defaultName: string;
  icon: string;
  services: ServiceDef[];
  hours: WeeklyHours;
  faqs: FaqDef[];
  sequences: SequenceDef[];
  /** Up to 3 qualifying questions Aria asks new leads. */
  qualifyingQuestions: string[];
  /** Extra guardrail rules added to Aria's prompt for this business type. */
  ariaRules: string[];
  agentSettings: Partial<Record<AgentKey, { enabled: boolean }>>;
  i18n?: Record<string, Partial<Pick<BusinessTemplate, 'faqs' | 'qualifyingQuestions'>>>;
}

const range = (from: string, to: string) => ({ from, to });
const day = (...ranges: { from: string; to: string }[]) => ({ open: ranges.length > 0, ranges });

/** Mon–Sat with the given ranges; Sunday as given (closed by default). */
function weekHours(ranges: { from: string; to: string }[], sunday: { from: string; to: string }[] = []): WeeklyHours {
  return {
    mon: day(...ranges),
    tue: day(...ranges),
    wed: day(...ranges),
    thu: day(...ranges),
    fri: day(...ranges),
    sat: day(...ranges),
    sun: day(...sunday),
  };
}

const reminders = (ownerAgent: AgentKey = 'nudge'): SequenceDef => ({
  name: 'Appointment reminders',
  trigger: 'booking_created',
  ownerAgent,
  steps: [
    { channel: 'whatsapp', delayMin: -24 * 60, template: 'Hi {{name}}, a reminder of your {{service}} at {{business}} tomorrow at {{time}}. Reply 1 to confirm or 2 to reschedule.' },
    { channel: 'whatsapp', delayMin: -2 * 60, template: 'Hi {{name}}, see you at {{time}} today for your {{service}}. {{business}}, {{address}}.' },
  ],
});


const leadFollowUp: SequenceDef = {
  name: 'Lead follow-up',
  trigger: 'lead_created',
  ownerAgent: 'nudge',
  steps: [
    { channel: 'whatsapp', delayMin: 24 * 60, template: 'Hi {{name}}, thanks for asking about {{interest}} at {{business}}. Would you like me to book a time for you?', condition: 'not_booked' },
    { channel: 'whatsapp', delayMin: 3 * 24 * 60, template: 'Hi {{name}}, just checking in. We have a few slots free this week for {{interest}}. Shall I hold one for you?', condition: 'not_booked' },
  ],
};

const reviewRequest: SequenceDef = {
  name: 'Thank you and review',
  trigger: 'booking_completed',
  ownerAgent: 'nudge',
  steps: [
    { channel: 'whatsapp', delayMin: 3 * 60, template: 'Thank you for visiting {{business}}, {{name}}! If you liked it, a quick review would mean a lot: {{review_link}}' },
  ],
};

const commonFaqs = (extra: FaqDef[] = []): FaqDef[] => [
  { question: 'What are your timings?', answer: 'Our opening hours are shown on our page. You can also ask me for a specific day.' },
  { question: 'Where are you located?', answer: 'Our address and map are on our page. I can send you the location too.' },
  { question: 'How do I pay?', answer: 'You can pay by UPI, card or cash at the counter.' },
  ...extra,
];

const crewDefaults: BusinessTemplate['agentSettings'] = {
  orbit: { enabled: true },
  aria: { enabled: true },
  nudge: { enabled: true },
  ledger: { enabled: true },
  vox: { enabled: false },
  spark: { enabled: false },
};

export const TEMPLATES: Record<BusinessType, BusinessTemplate> = {
  clinic: {
    type: 'clinic',
    defaultName: 'My Clinic',
    icon: '🩺',
    services: [
      { name: 'Consultation', durationMin: 15, price: 500, bufferAfterMin: 5, category: 'Consultation' },
      { name: 'Follow-up visit', durationMin: 10, price: 300, bufferAfterMin: 5, category: 'Consultation', renewalIntervalDays: 14 },
      { name: 'Procedure', description: 'Time and price confirmed by the doctor', durationMin: 30, price: null, category: 'Procedures' },
    ],
    hours: weekHours([range('09:00', '13:00'), range('17:00', '21:00')]),
    faqs: commonFaqs([
      { question: 'Do I need an appointment?', answer: 'Appointments are recommended so you do not have to wait. Walk-ins are seen when the doctor is free.' },
    ]),
    sequences: [
      leadFollowUp,
      reminders(),
      { name: 'Follow-up visit reminder', trigger: 'renewal_due', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Hi {{name}}, the doctor asked to see you for a follow-up around now. Shall I book a time?' }] },
      { name: 'Feedback after visit', trigger: 'booking_completed', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 24 * 60, template: 'Hi {{name}}, how are you feeling after your visit to {{business}}? Reply anytime if you need us.' }] },
    ],
    qualifyingQuestions: ['Is this your first visit, or have you seen us before?', 'What is the reason for your visit?', 'Do you have a preferred doctor?'],
    ariaRules: [
      'Never give medical advice, diagnosis or medicine suggestions.',
      'If the person describes urgent symptoms (chest pain, breathing trouble, heavy bleeding, unconsciousness), tell them to call emergency services (112) or the clinic directly right away, and hand over to a human.',
    ],
    agentSettings: crewDefaults,
  },
  dental_clinic: {
    type: 'dental_clinic',
    defaultName: 'My Dental Clinic',
    icon: '🦷',
    services: [
      { name: 'Dental check-up', durationMin: 20, price: 400, bufferAfterMin: 10, category: 'Check-up', renewalIntervalDays: 180 },
      { name: 'Teeth cleaning', durationMin: 40, price: 1200, bufferAfterMin: 10, category: 'Cleaning', renewalIntervalDays: 180 },
      { name: 'Filling', durationMin: 45, price: 1500, bufferAfterMin: 10, category: 'Treatment' },
      { name: 'Root canal (consultation)', durationMin: 30, price: null, category: 'Treatment' },
    ],
    hours: weekHours([range('10:00', '14:00'), range('16:00', '20:30')]),
    faqs: commonFaqs([{ question: 'Does a check-up hurt?', answer: 'A check-up is a quick, painless look at your teeth and gums. The dentist will explain anything else before doing it.' }]),
    sequences: [
      leadFollowUp,
      reminders(),
      { name: 'Six-month check-up', trigger: 'renewal_due', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Hi {{name}}, it has been about 6 months since your last dental check-up. Shall I book your next one?' }] },
      reviewRequest,
    ],
    qualifyingQuestions: ['Is this your first visit?', 'Are you in pain right now?', 'Which treatment are you interested in?'],
    ariaRules: ['Never give medical or dental advice or medicine suggestions.', 'If the person has severe pain, swelling or bleeding, offer the earliest slot and hand over to a human.'],
    agentSettings: crewDefaults,
  },
  salon: {
    type: 'salon',
    defaultName: 'My Salon',
    icon: '💇',
    services: [
      { name: 'Haircut', durationMin: 30, price: 300, bufferAfterMin: 10, category: 'Hair', renewalIntervalDays: 35 },
      { name: 'Hair colour', durationMin: 90, price: 1500, bufferAfterMin: 15, category: 'Hair', renewalIntervalDays: 45 },
      { name: 'Facial', durationMin: 60, price: 1200, bufferAfterMin: 10, category: 'Skin' },
      { name: 'Head massage', durationMin: 30, price: 400, category: 'Relax' },
      { name: 'Beard trim', durationMin: 15, price: 150, category: 'Grooming', renewalIntervalDays: 21 },
    ],
    hours: weekHours([range('10:00', '21:00')], [range('10:00', '18:00')]),
    faqs: commonFaqs([{ question: 'Do you take walk-ins?', answer: 'Yes, if a stylist is free. Booking ahead means no waiting.' }]),
    sequences: [
      leadFollowUp,
      reminders(),
      { name: 'Rebooking nudge', trigger: 'renewal_due', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Hi {{name}}, it has been a few weeks since your {{service}}. Want me to book your next visit?' }] },
      { name: 'Birthday offer', trigger: 'birthday', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Happy birthday {{name}}! Enjoy a special treat on your next visit to {{business}} this month.' }] },
      reviewRequest,
    ],
    qualifyingQuestions: ['Which service would you like?', 'Do you have a preferred stylist?', 'Is this your first visit with us?'],
    ariaRules: [],
    agentSettings: crewDefaults,
  },
  spa: {
    type: 'spa',
    defaultName: 'My Spa',
    icon: '💆',
    services: [
      { name: 'Swedish massage', durationMin: 60, price: 2500, bufferAfterMin: 15, category: 'Massage' },
      { name: 'Deep tissue massage', durationMin: 60, price: 3000, bufferAfterMin: 15, category: 'Massage' },
      { name: 'Body scrub', durationMin: 45, price: 2000, bufferAfterMin: 15, category: 'Body' },
      { name: 'Foot reflexology', durationMin: 30, price: 1000, bufferAfterMin: 10, category: 'Relax' },
    ],
    hours: weekHours([range('10:00', '21:00')], [range('10:00', '21:00')]),
    faqs: commonFaqs([{ question: 'What should I bring?', answer: 'Nothing at all. We provide towels, robes and everything you need.' }]),
    sequences: [
      leadFollowUp,reminders(), reviewRequest, { name: 'Birthday offer', trigger: 'birthday', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Happy birthday {{name}}! Treat yourself to a relaxing visit at {{business}} this month.' }] }],
    qualifyingQuestions: ['Which treatment are you interested in?', 'Do you prefer a male or female therapist?', 'Is this your first visit?'],
    ariaRules: [],
    agentSettings: crewDefaults,
  },
  gym: {
    type: 'gym',
    defaultName: 'My Gym',
    icon: '🏋️',
    services: [
      { name: 'Free trial session', durationMin: 60, price: 0, category: 'Trial' },
      { name: 'Monthly membership', durationMin: 0, price: 1500, category: 'Membership', renewalIntervalDays: 30 },
      { name: 'Quarterly membership', durationMin: 0, price: 4000, category: 'Membership', renewalIntervalDays: 90 },
      { name: 'Annual membership', durationMin: 0, price: 12000, category: 'Membership', renewalIntervalDays: 365 },
      { name: 'Personal training session', durationMin: 60, price: 800, bufferAfterMin: 10, category: 'Personal training' },
    ],
    hours: weekHours([range('05:30', '22:00')], [range('06:00', '12:00')]),
    faqs: commonFaqs([{ question: 'Do you have a trainer?', answer: 'Yes, floor trainers are available during all hours. Personal training can be booked separately.' }]),
    sequences: [
      leadFollowUp,
      { name: 'Trial follow-up', trigger: 'booking_completed', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 6 * 60, template: 'Hi {{name}}, great to have you at {{business}} today! Ready to start your membership?', condition: 'service_category=Trial' }] },
      { name: 'Renewal reminders', trigger: 'renewal_due', ownerAgent: 'nudge', steps: [
        { channel: 'whatsapp', delayMin: -7 * 24 * 60, template: 'Hi {{name}}, your membership at {{business}} ends in 7 days. Shall I send a renewal link?' },
        { channel: 'whatsapp', delayMin: -2 * 24 * 60, template: 'Hi {{name}}, your membership ends in 2 days. Renew now to keep your streak going!' },
      ] },
      { name: 'Win-back', trigger: 'inactive_days', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 14 * 24 * 60, template: 'Hi {{name}}, we have missed you at {{business}}! Come back this week, your spot is waiting.' }] },
    ],
    qualifyingQuestions: ['What is your fitness goal?', 'What time of day do you prefer to work out?', 'Have you trained in a gym before?'],
    ariaRules: ['Do not give medical or diet advice; suggest speaking to a trainer or doctor.'],
    agentSettings: crewDefaults,
  },
  yoga_studio: {
    type: 'yoga_studio',
    defaultName: 'My Yoga Studio',
    icon: '🧘',
    services: [
      { name: 'Trial class', durationMin: 60, price: 0, category: 'Trial' },
      { name: 'Drop-in class', durationMin: 60, price: 300, category: 'Class' },
      { name: 'Monthly membership', durationMin: 0, price: 2500, category: 'Membership', renewalIntervalDays: 30 },
      { name: 'Private session', durationMin: 60, price: 1200, category: 'Private' },
    ],
    hours: weekHours([range('06:00', '10:00'), range('17:00', '20:30')], [range('07:00', '09:00')]),
    faqs: commonFaqs([{ question: 'I am a beginner. Can I join?', answer: 'Of course! Our classes welcome beginners. Tell the teacher it is your first class.' }]),
    sequences: [
      leadFollowUp,
      { name: 'Trial follow-up', trigger: 'booking_completed', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 6 * 60, template: 'Hi {{name}}, lovely to have you in class today! Would you like to join for the month?', condition: 'service_category=Trial' }] },
      { name: 'Renewal reminders', trigger: 'renewal_due', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: -7 * 24 * 60, template: 'Hi {{name}}, your membership ends in 7 days. Shall I send a renewal link?' }, { channel: 'whatsapp', delayMin: -2 * 24 * 60, template: 'Hi {{name}}, your membership ends in 2 days.' }] },
      { name: 'Win-back', trigger: 'inactive_days', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 14 * 24 * 60, template: 'Hi {{name}}, your mat misses you! Join a class at {{business}} this week.' }] },
    ],
    qualifyingQuestions: ['What would you like from yoga: fitness, flexibility or calm?', 'Morning or evening classes?', 'Have you practised yoga before?'],
    ariaRules: ['Do not give medical advice; suggest speaking to the teacher or a doctor about injuries.'],
    agentSettings: crewDefaults,
  },
  coaching_centre: {
    type: 'coaching_centre',
    defaultName: 'My Coaching Centre',
    icon: '🎓',
    services: [
      { name: 'Free demo class', durationMin: 60, price: 0, category: 'Demo' },
      { name: 'Monthly batch', durationMin: 0, price: 3000, category: 'Batch', renewalIntervalDays: 30 },
      { name: 'One-on-one session', durationMin: 60, price: 800, category: 'One-on-one' },
    ],
    hours: weekHours([range('07:00', '10:00'), range('16:00', '21:00')]),
    faqs: commonFaqs([{ question: 'What is the batch size?', answer: 'Batches are kept small so every student gets attention. Ask us for the size of a specific batch.' }]),
    sequences: [
      { name: 'Demo follow-up', trigger: 'booking_completed', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 6 * 60, template: 'Hi {{name}}, thank you for attending the demo class at {{business}}. Would you like to join a batch?', condition: 'service_category=Demo' }] },
      { name: 'Fee reminders', trigger: 'renewal_due', ownerAgent: 'ledger', steps: [{ channel: 'whatsapp', delayMin: -3 * 24 * 60, template: 'Hi {{name}}, a reminder that next month’s fee is due on {{due_date}}.' }] },
      leadFollowUp,
    ],
    qualifyingQuestions: ['Which class or grade is the student in?', 'Which subject is needed?', 'Which batch time suits you?'],
    ariaRules: [],
    agentSettings: crewDefaults,
  },
  tuition: {
    type: 'tuition',
    defaultName: 'My Tuition Classes',
    icon: '📚',
    services: [
      { name: 'Demo class', durationMin: 60, price: 0, category: 'Demo' },
      { name: 'Monthly tuition', durationMin: 0, price: 2000, category: 'Monthly', renewalIntervalDays: 30 },
      { name: 'Home tuition (per hour)', durationMin: 60, price: 500, category: 'Home' },
    ],
    hours: weekHours([range('15:00', '20:00')], [range('09:00', '12:00')]),
    faqs: commonFaqs([{ question: 'Which boards do you teach?', answer: 'Please tell us the board and class, and we will confirm the right batch for you.' }]),
    sequences: [
      leadFollowUp,
      { name: 'Demo follow-up', trigger: 'booking_completed', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 6 * 60, template: 'Hi {{name}}, thank you for the demo class. Shall we reserve a seat in the batch?', condition: 'service_category=Demo' }] },
      { name: 'Fee reminders', trigger: 'renewal_due', ownerAgent: 'ledger', steps: [{ channel: 'whatsapp', delayMin: -3 * 24 * 60, template: 'Hi {{name}}, a reminder that the tuition fee is due on {{due_date}}.' }] },
      { name: 'Parent update', trigger: 'manual', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Hi {{name}}, here is this month’s update from {{business}}: {{note}}' }] },
    ],
    qualifyingQuestions: ['Which class or grade is the student in?', 'Which subject is needed?', 'Which batch time suits you?'],
    ariaRules: [],
    agentSettings: crewDefaults,
  },
  restaurant: {
    type: 'restaurant',
    defaultName: 'My Restaurant',
    icon: '🍽️',
    services: [
      { name: 'Table reservation', durationMin: 90, price: null, category: 'Reservation' },
      { name: 'Catering enquiry', durationMin: 0, price: null, category: 'Catering' },
    ],
    hours: weekHours([range('12:00', '15:30'), range('19:00', '23:00')], [range('12:00', '15:30'), range('19:00', '23:00')]),
    faqs: commonFaqs([
      { question: 'Do you have vegetarian options?', answer: 'Please check our menu on the page, or ask me about a specific dish.' },
      { question: 'Do you deliver?', answer: 'Please ask us and we will confirm delivery options for your area.' },
    ]),
    sequences: [
      leadFollowUp,
      { name: 'Reservation reminder', trigger: 'booking_created', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: -3 * 60, template: 'Hi {{name}}, your table at {{business}} is ready for {{time}} today. See you soon!' }] },
      { name: 'Feedback', trigger: 'booking_completed', ownerAgent: 'nudge', steps: [{ channel: 'whatsapp', delayMin: 3 * 60, template: 'Thank you for dining at {{business}}, {{name}}! How was everything? {{review_link}}' }] },
      { name: 'Festival offer', trigger: 'festival', ownerAgent: 'spark', steps: [{ channel: 'whatsapp', delayMin: 0, template: 'Happy {{festival}} from {{business}}! {{offer}}' }] },
    ],
    qualifyingQuestions: ['How many people?', 'Which date and time?', 'Is it for a special occasion?'],
    ariaRules: ['Do not confirm allergen safety; say the team will confirm with the kitchen and hand over.'],
    agentSettings: crewDefaults,
  },
  retail: {
    type: 'retail',
    defaultName: 'My Shop',
    icon: '🛍️',
    services: [
      { name: 'Product enquiry', durationMin: 0, price: null, category: 'Enquiry' },
      { name: 'Store visit', durationMin: 30, price: null, category: 'Visit' },
    ],
    hours: weekHours([range('10:00', '21:00')], [range('11:00', '20:00')]),
    faqs: commonFaqs([{ question: 'Is this item in stock?', answer: 'Tell me which item and I will check with the team.' }, { question: 'Do you offer returns?', answer: 'Please ask us about the return policy for your item.' }]),
    sequences: [leadFollowUp, reviewRequest],
    qualifyingQuestions: ['Which product are you looking for?', 'What budget do you have in mind?', 'Would you like to visit or get it delivered?'],
    ariaRules: [],
    agentSettings: crewDefaults,
  },
  repair: {
    type: 'repair',
    defaultName: 'My Repair Service',
    icon: '🔧',
    services: [
      { name: 'Inspection visit', durationMin: 60, price: 300, bufferAfterMin: 30, category: 'Inspection' },
      { name: 'Repair (price after inspection)', durationMin: 120, price: null, category: 'Repair' },
    ],
    hours: weekHours([range('09:00', '19:00')]),
    faqs: commonFaqs([{ question: 'How much will the repair cost?', answer: 'The exact price is confirmed after inspection. I can book an inspection for you.' }]),
    sequences: [reminders(), leadFollowUp, reviewRequest],
    qualifyingQuestions: ['What needs repair?', 'Which area are you in?', 'When would you like us to come?'],
    ariaRules: ['Never quote a repair price before inspection.'],
    agentSettings: crewDefaults,
  },
  real_estate: {
    type: 'real_estate',
    defaultName: 'My Property Agency',
    icon: '🏠',
    services: [
      { name: 'Property site visit', durationMin: 60, price: 0, bufferAfterMin: 30, category: 'Visit' },
      { name: 'Consultation call', durationMin: 30, price: 0, category: 'Consultation' },
    ],
    hours: weekHours([range('10:00', '19:00')], [range('10:00', '17:00')]),
    faqs: commonFaqs([{ question: 'Is this property still available?', answer: 'Tell me which property and I will check with the team.' }]),
    sequences: [reminders(), leadFollowUp],
    qualifyingQuestions: ['Are you looking to buy or rent?', 'Which area and budget?', 'How many bedrooms do you need?'],
    ariaRules: ['Never give legal or financial advice about loans, documents or taxes.'],
    agentSettings: crewDefaults,
  },
  other: {
    type: 'other',
    defaultName: 'My Business',
    icon: '✨',
    services: [
      { name: 'Appointment', durationMin: 30, price: null, category: 'General' },
      { name: 'Enquiry', durationMin: 0, price: null, category: 'General' },
    ],
    hours: weekHours([range('10:00', '19:00')]),
    faqs: commonFaqs(),
    sequences: [reminders(), leadFollowUp, reviewRequest],
    qualifyingQuestions: ['What are you looking for?', 'When would suit you?'],
    ariaRules: [],
    agentSettings: crewDefaults,
  },
};
