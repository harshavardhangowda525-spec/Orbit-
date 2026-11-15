# Phase 4 — Snap to set up, and Khata (the accounts agent). Imported by build-locales.py.
def add(k):
  k('agent.khata.name','Khata','Khata','Khata')
  k('agent.khata.role','Accounts','हिसाब-किताब','ಲೆಕ್ಕಪತ್ರ')
  # categories and payment modes
  for c,(e,h,n) in {
    'rent':('Rent','किराया','ಬಾಡಿಗೆ'),'salaries':('Salaries','वेतन','ಸಂಬಳ'),'supplies':('Supplies & stock','सामान और स्टॉक','ಸಾಮಗ್ರಿ ಮತ್ತು ಸ್ಟಾಕ್'),
    'utilities':('Utilities','पानी-गैस','ನೀರು-ಅನಿಲ'),'electricity':('Electricity','बिजली','ವಿದ್ಯುತ್'),'internet':('Internet & phone','इंटरनेट और फ़ोन','ಇಂಟರ್ನೆಟ್ ಮತ್ತು ಫೋನ್'),
    'marketing':('Marketing','मार्केटिंग','ಮಾರ್ಕೆಟಿಂಗ್'),'equipment':('Equipment','उपकरण','ಉಪಕರಣ'),'repairs':('Repairs','मरम्मत','ದುರಸ್ತಿ'),
    'transport':('Transport','आवाजाही','ಸಾರಿಗೆ'),'food':('Food','खाना','ಊಟ'),'professional_fees':('Professional fees','पेशेवर फ़ीस','ವೃತ್ತಿಪರ ಶುಲ್ಕ'),'other':('Other','अन्य','ಇತರೆ'),
  }.items():
    k(f'khata.cat.{c}',e,h,n)
  for m,(e,h,n) in {'cash':('cash','नकद','ನಗದು'),'upi':('UPI','UPI','UPI'),'card':('card','कार्ड','ಕಾರ್ಡ್'),'other':('other','अन्य','ಇತರೆ')}.items():
    k(f'khata.mode.{m}',e,h,n)
  # feed
  k('feed.khata.expense','Khata added {{amount}} {{category}} bill from {{vendor}}','Khata ने {{vendor}} का {{amount}} का {{category}} बिल जोड़ा','Khata {{vendor}} ಅವರ {{amount}} {{category}} ಬಿಲ್ ಸೇರಿಸಿತು')
  k('feed.khata.sale','Khata recorded a {{amount}} {{mode}} sale','Khata ने {{amount}} की {{mode}} बिक्री दर्ज की','Khata {{amount}} {{mode}} ಮಾರಾಟ ದಾಖಲಿಸಿತು')
  k('feed.khata.month','{{month}} books are ready: profit {{profit}}','{{month}} का हिसाब तैयार: मुनाफ़ा {{profit}}','{{month}} ಲೆಕ್ಕ ಸಿದ್ಧ: ಲಾಭ {{profit}}')
  k('feed.orbit.services_added','Orbit added {{count}} services from your photo','Orbit ने आपकी फ़ोटो से {{count}} सेवाएँ जोड़ीं','Orbit ನಿಮ್ಮ ಫೋಟೋದಿಂದ {{count}} ಸೇವೆಗಳನ್ನು ಸೇರಿಸಿತು')
  k('feed.orbit.services_added.one','Orbit added {{count}} service from your photo','Orbit ने आपकी फ़ोटो से {{count}} सेवा जोड़ी','Orbit ನಿಮ್ಮ ಫೋಟೋದಿಂದ {{count}} ಸೇವೆ ಸೇರಿಸಿತು')
  # why?
  k('why.action.khata.saved','{{agent}} saved the {{amount}} bill from {{vendor}}','{{agent}} ने {{vendor}} का {{amount}} का बिल सहेजा','{{agent}} {{vendor}} ಅವರ {{amount}} ಬಿಲ್ ಉಳಿಸಿತು')
  k('why.action.khata.sale','{{agent}} recorded a {{amount}} sale','{{agent}} ने {{amount}} की बिक्री दर्ज की','{{agent}} {{amount}} ಮಾರಾಟ ದಾಖಲಿಸಿತು')
  k('why.action.khata.month','{{agent}} closed the books for {{month}}','{{agent}} ने {{month}} का हिसाब बंद किया','{{agent}} {{month}} ಲೆಕ್ಕವನ್ನು ಮುಚ್ಚಿತು')
  k('why.action.orbit.services_added','Orbit added {{count}} services','Orbit ने {{count}} सेवाएँ जोड़ीं','Orbit {{count}} ಸೇವೆಗಳನ್ನು ಸೇರಿಸಿತು')
  k('why.action.orbit.services_added.one','Orbit added {{count}} service','Orbit ने {{count}} सेवा जोड़ी','Orbit {{count}} ಸೇವೆ ಸೇರಿಸಿತು')
  k('why.rule.khata.auto_save','Auto-save bills from {{vendor}}','{{vendor}} के बिल अपने-आप सहेजें','{{vendor}} ಬಿಲ್‌ಗಳನ್ನು ಸ್ವಯಂ ಉಳಿಸಿ')
  k('why.rule.khata.monthly','Monthly books on the 1st','हर महीने की 1 तारीख को हिसाब','ಪ್ರತಿ ತಿಂಗಳ 1ರಂದು ಲೆಕ್ಕ')
  k('why.fact.bill','the bill from {{vendor}} on {{date}} is for {{amount}}','{{vendor}} का {{date}} का बिल {{amount}} का है','{{vendor}} ಅವರ {{date}} ರ ಬಿಲ್ {{amount}} ಗೆ ಇದೆ')
  k('why.fact.bill_numbered','bill {{number}} from {{vendor}} on {{date}} is for {{amount}}','{{vendor}} का बिल {{number}} ({{date}}) {{amount}} का है','{{vendor}} ಅವರ ಬಿಲ್ {{number}} ({{date}}) {{amount}} ಗೆ ಇದೆ')
  k('why.fact.category_from_vendor','you filed {{vendor}} under {{category}} before','आपने पहले {{vendor}} को {{category}} में रखा था','ನೀವು ಹಿಂದೆ {{vendor}} ಅನ್ನು {{category}} ಅಡಿಯಲ್ಲಿ ಇಟ್ಟಿದ್ದಿರಿ')
  k('why.fact.category_chosen','you chose {{category}}','आपने {{category}} चुना','ನೀವು {{category}} ಆರಿಸಿದಿರಿ')
  k('why.fact.sale_logged','you added {{amount}} ({{mode}}) for {{date}}','आपने {{date}} के लिए {{amount}} ({{mode}}) जोड़े','ನೀವು {{date}} ಗೆ {{amount}} ({{mode}}) ಸೇರಿಸಿದಿರಿ')
  k('why.fact.checkin_answer','you answered the evening check-in with {{amount}} for {{date}}','आपने {{date}} की शाम की जाँच में {{amount}} बताया','ನೀವು {{date}} ಸಂಜೆಯ ಪರಿಶೀಲನೆಯಲ್ಲಿ {{amount}} ಎಂದಿರಿ')
  k('why.fact.settlement_read','your settlement screenshot showed {{amount}} for {{date}}','आपके सेटलमेंट स्क्रीनशॉट में {{date}} के लिए {{amount}} था','ನಿಮ್ಮ ಸೆಟಲ್‌ಮೆಂಟ್ ಸ್ಕ್ರೀನ್‌ಶಾಟ್‌ನಲ್ಲಿ {{date}} ಗೆ {{amount}} ಇತ್ತು')
  k('why.fact.month_revenue','revenue was {{amount}}','आमदनी {{amount}} रही','ಆದಾಯ {{amount}} ಆಗಿತ್ತು')
  k('why.fact.month_expenses','expenses were {{amount}}','खर्च {{amount}} रहा','ಖರ್ಚು {{amount}} ಆಗಿತ್ತು')
  k('why.fact.read_from_photos','Orbit read them from {{count}} photos','Orbit ने इन्हें {{count}} फ़ोटो से पढ़ा','Orbit ಇವುಗಳನ್ನು {{count}} ಫೋಟೋಗಳಿಂದ ಓದಿತು')
  k('why.fact.read_from_photos.one','Orbit read them from your photo','Orbit ने इन्हें आपकी फ़ोटो से पढ़ा','Orbit ಇವುಗಳನ್ನು ನಿಮ್ಮ ಫೋಟೋದಿಂದ ಓದಿತು')
  k('why.fact.you_checked','you checked and kept {{count}} of them','आपने जाँचकर {{count}} रखीं','ನೀವು ಪರಿಶೀಲಿಸಿ {{count}} ಉಳಿಸಿದಿರಿ')
  # the books
  k('khata.note.based_on','Based on bills and sales added to Orbit.','Orbit में जोड़े गए बिल और बिक्री के आधार पर।','Orbit ಗೆ ಸೇರಿಸಿದ ಬಿಲ್ ಮತ್ತು ಮಾರಾಟದ ಆಧಾರದ ಮೇಲೆ.')
  k('khata.gst.verify','For your accountant to verify. This is not tax advice.','आपके अकाउंटेंट द्वारा जाँच के लिए। यह टैक्स सलाह नहीं है।','ನಿಮ್ಮ ಲೆಕ್ಕಿಗರು ಪರಿಶೀಲಿಸಲು. ಇದು ತೆರಿಗೆ ಸಲಹೆಯಲ್ಲ.')
  k('khata.compare.more','{{amount}} more profit than {{month}}','{{month}} से {{amount}} ज़्यादा मुनाफ़ा','{{month}} ಗಿಂತ {{amount}} ಹೆಚ್ಚು ಲಾಭ')
  k('khata.compare.less','{{amount}} less profit than {{month}}','{{month}} से {{amount}} कम मुनाफ़ा','{{month}} ಗಿಂತ {{amount}} ಕಡಿಮೆ ಲಾಭ')
  k('khata.compare.same','Same profit as {{month}}','{{month}} जितना ही मुनाफ़ा','{{month}} ನಷ್ಟೇ ಲಾಭ')
  k('khata.insight.biggest','{{category}} was your biggest cost ({{amount}}).','{{category}} आपका सबसे बड़ा खर्च रहा ({{amount}})।','{{category}} ನಿಮ್ಮ ದೊಡ್ಡ ಖರ್ಚು ({{amount}}).')
  k('khata.insight.higher','{{category}} is {{pct}}% higher than your 3-month average.','{{category}} आपके 3 महीने के औसत से {{pct}}% ज़्यादा है।','{{category}} ನಿಮ್ಮ 3 ತಿಂಗಳ ಸರಾಸರಿಗಿಂತ {{pct}}% ಹೆಚ್ಚು.')
  k('khata.insight.lower','{{category}} is {{pct}}% lower than your 3-month average.','{{category}} आपके 3 महीने के औसत से {{pct}}% कम है।','{{category}} ನಿಮ್ಮ 3 ತಿಂಗಳ ಸರಾಸರಿಗಿಂತ {{pct}}% ಕಡಿಮೆ.')
  k('khata.insight.cash_share','{{pct}}% of this month’s money came in as cash or your own UPI/card.','इस महीने का {{pct}}% पैसा नकद या आपके अपने UPI/कार्ड से आया।','ಈ ತಿಂಗಳ ಹಣದ {{pct}}% ನಗದು ಅಥವಾ ನಿಮ್ಮ ಸ್ವಂತ UPI/ಕಾರ್ಡ್‌ನಿಂದ ಬಂತು.')
  # needs you, notifications, briefing, change history
  k('card.cash_checkin','How much did you take in cash on {{date}}?','{{date}} को कितना नकद आया?','{{date}} ರಂದು ಎಷ್ಟು ನಗದು ಬಂತು?')
  k('card.option.save','Save','सेव करें','ಉಳಿಸಿ')
  k('card.option.no_cash','No cash today','आज नकद नहीं','ಇಂದು ನಗದು ಇಲ್ಲ')
  k('notify.khata.bill_due','{{vendor}} bill (about {{amount}}) is due on {{date}}.','{{vendor}} का बिल (लगभग {{amount}}) {{date}} को देय है।','{{vendor}} ಬಿಲ್ (ಸುಮಾರು {{amount}}) {{date}} ರಂದು ಬಾಕಿ ಇದೆ.')
  k('brief.spent_today','Spent today: {{amount}}.','आज का खर्च: {{amount}}।','ಇಂದಿನ ಖರ್ಚು: {{amount}}.')
  k('brief.spent_yesterday','Spent yesterday: {{amount}}.','कल का खर्च: {{amount}}।','ನಿನ್ನೆಯ ಖರ್ಚು: {{amount}}.')
  k('change.expense_added','Added {{amount}} bill from {{vendor}}','{{vendor}} का {{amount}} का बिल जोड़ा','{{vendor}} ಅವರ {{amount}} ಬಿಲ್ ಸೇರಿಸಲಾಗಿದೆ')
  k('change.expense_edited','Edited the bill from {{vendor}}','{{vendor}} का बिल बदला','{{vendor}} ಅವರ ಬಿಲ್ ಬದಲಿಸಲಾಗಿದೆ')
  k('change.expense_removed','Removed the bill from {{vendor}}','{{vendor}} का बिल हटाया','{{vendor}} ಅವರ ಬಿಲ್ ತೆಗೆದುಹಾಕಲಾಗಿದೆ')
  k('change.sale_added','Added a {{amount}} sale','{{amount}} की बिक्री जोड़ी','{{amount}} ಮಾರಾಟ ಸೇರಿಸಲಾಗಿದೆ')
