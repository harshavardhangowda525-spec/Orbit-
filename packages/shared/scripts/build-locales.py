import json, sys
out = sys.argv[1]
T = {}
def k(key, en, hi, kn): T[key] = (en, hi, kn)

# common
k('common.loading','Loading…','लोड हो रहा है…','ಲೋಡ್ ಆಗುತ್ತಿದೆ…')
k('common.wait','Please wait…','कृपया रुकें…','ದಯವಿಟ್ಟು ಕಾಯಿರಿ…')
k('common.continue','Continue','आगे बढ़ें','ಮುಂದುವರಿಸಿ')
k('common.back','Back','पीछे','ಹಿಂದೆ')
k('common.add','Add','जोड़ें','ಸೇರಿಸಿ')
k('common.remove','Remove','हटाएँ','ತೆಗೆದುಹಾಕಿ')
k('common.close','Close','बंद करें','ಮುಚ್ಚಿ')
k('common.closed','Closed','बंद','ಮುಚ್ಚಿದೆ')
k('common.copy','Copy','कॉपी करें','ನಕಲಿಸಿ')
k('common.copied','Copied','कॉपी हो गया','ನಕಲಿಸಲಾಗಿದೆ')
k('common.optional','Optional','ज़रूरी नहीं','ಐಚ್ಛಿಕ')
k('common.language','Language','भाषा','ಭಾಷೆ')

# landing + login
k('landing.title','Your business, handled.','आपका बिज़नेस, संभला हुआ।','ನಿಮ್ಮ ವ್ಯಾಪಾರ, ನಿಭಾಯಿಸಲಾಗಿದೆ.')
k('landing.subtitle','Orbit answers your customers, books appointments, follows up and tells you every morning how your business is doing.','Orbit आपके ग्राहकों को जवाब देता है, अपॉइंटमेंट बुक करता है, फ़ॉलो-अप करता है और हर सुबह बताता है कि आपका बिज़नेस कैसा चल रहा है।','Orbit ನಿಮ್ಮ ಗ್ರಾಹಕರಿಗೆ ಉತ್ತರಿಸುತ್ತದೆ, ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡುತ್ತದೆ, ಫಾಲೋ-ಅಪ್ ಮಾಡುತ್ತದೆ ಮತ್ತು ಪ್ರತಿದಿನ ಬೆಳಿಗ್ಗೆ ನಿಮ್ಮ ವ್ಯಾಪಾರ ಹೇಗಿದೆ ಎಂದು ಹೇಳುತ್ತದೆ.')
k('landing.cta','Start free','मुफ़्त शुरू करें','ಉಚಿತವಾಗಿ ಪ್ರಾರಂಭಿಸಿ')
k('landing.under2','Ready in under 2 minutes. No card needed.','2 मिनट से कम में तैयार। कार्ड की ज़रूरत नहीं।','2 ನಿಮಿಷಕ್ಕಿಂತ ಕಡಿಮೆ ಸಮಯದಲ್ಲಿ ಸಿದ್ಧ. ಕಾರ್ಡ್ ಬೇಕಿಲ್ಲ.')
k('login.title','Sign in with your phone','अपने फ़ोन से साइन इन करें','ನಿಮ್ಮ ಫೋನ್ ಮೂಲಕ ಸೈನ್ ಇನ್ ಮಾಡಿ')
k('login.phone','Mobile number','मोबाइल नंबर','ಮೊಬೈಲ್ ಸಂಖ್ಯೆ')
k('login.send_code','Email me a code','मुझे ईमेल पर कोड भेजें','ನನಗೆ ಇಮೇಲ್‌ನಲ್ಲಿ ಕೋಡ್ ಕಳುಹಿಸಿ')
k('login.enter_code','Enter the 6-digit code','6 अंकों का कोड डालें','6 ಅಂಕಿಯ ಕೋಡ್ ನಮೂದಿಸಿ')
k('login.code','Code','कोड','ಕೋಡ್')
k('login.code_sent','We sent a code to {{phone}}.','हमने {{phone}} पर कोड भेजा है।','ನಾವು {{phone}} ಗೆ ಕೋಡ್ ಕಳುಹಿಸಿದ್ದೇವೆ.')
k('login.dev_code','Test mode: your code is {{code}}','टेस्ट मोड: आपका कोड {{code}} है','ಪರೀಕ್ಷಾ ಮೋಡ್: ನಿಮ್ಮ ಕೋಡ್ {{code}}')
k('login.verify','Sign in','साइन इन करें','ಸೈನ್ ಇನ್ ಮಾಡಿ')
k('login.change_number','Use a different number','दूसरा नंबर इस्तेमाल करें','ಬೇರೆ ಸಂಖ್ಯೆ ಬಳಸಿ')
k('login.or','or','या','ಅಥವಾ')
k('login.terms','By continuing you agree to Orbit\'s terms and privacy policy.','आगे बढ़कर आप Orbit की शर्तों और गोपनीयता नीति से सहमत होते हैं।','ಮುಂದುವರಿಯುವ ಮೂಲಕ ನೀವು Orbit ನ ನಿಯಮಗಳು ಮತ್ತು ಗೌಪ್ಯತಾ ನೀತಿಗೆ ಒಪ್ಪುತ್ತೀರಿ.')

# business types
types = {
 'clinic':('Clinic','क्लिनिक','ಕ್ಲಿನಿಕ್'),
 'dental_clinic':('Dental clinic','डेंटल क्लिनिक','ದಂತ ಚಿಕಿತ್ಸಾಲಯ'),
 'salon':('Salon','सैलून','ಸಲೂನ್'),
 'spa':('Spa','स्पा','ಸ್ಪಾ'),
 'gym':('Gym','जिम','ಜಿಮ್'),
 'yoga_studio':('Yoga studio','योग स्टूडियो','ಯೋಗ ಸ್ಟುಡಿಯೋ'),
 'coaching_centre':('Coaching centre','कोचिंग सेंटर','ಕೋಚಿಂಗ್ ಕೇಂದ್ರ'),
 'tuition':('Tuition','ट्यूशन','ಟ್ಯೂಷನ್'),
 'restaurant':('Restaurant / café','रेस्टोरेंट / कैफ़े','ರೆಸ್ಟೋರೆಂಟ್ / ಕೆಫೆ'),
 'retail':('Retail shop','दुकान','ಅಂಗಡಿ'),
 'repair':('Repair service','रिपेयर सर्विस','ರಿಪೇರಿ ಸೇವೆ'),
 'real_estate':('Real estate','रियल एस्टेट','ರಿಯಲ್ ಎಸ್ಟೇಟ್'),
 'other':('Something else','कुछ और','ಬೇರೆ ಏನಾದರೂ'),
}
for t,(a,b,c) in types.items(): k(f'type.{t}',a,b,c)

# weekdays
wd = {
 'mon':('Monday','सोमवार','ಸೋಮವಾರ','Mon','सोम','ಸೋಮ'),
 'tue':('Tuesday','मंगलवार','ಮಂಗಳವಾರ','Tue','मंगल','ಮಂಗಳ'),
 'wed':('Wednesday','बुधवार','ಬುಧವಾರ','Wed','बुध','ಬುಧ'),
 'thu':('Thursday','गुरुवार','ಗುರುವಾರ','Thu','गुरु','ಗುರು'),
 'fri':('Friday','शुक्रवार','ಶುಕ್ರವಾರ','Fri','शुक्र','ಶುಕ್ರ'),
 'sat':('Saturday','शनिवार','ಶನಿವಾರ','Sat','शनि','ಶನಿ'),
 'sun':('Sunday','रविवार','ಭಾನುವಾರ','Sun','रवि','ಭಾನು'),
}
for d,v in wd.items():
  k(f'weekday.{d}',v[0],v[1],v[2]); k(f'weekday.short.{d}',v[3],v[4],v[5])

# onboarding
k('ob.step_of','Step {{n}} of {{total}}','चरण {{n}} / {{total}}','ಹಂತ {{n}} / {{total}}')
k('ob.type.title','What kind of business do you run?','आपका बिज़नेस किस तरह का है?','ನಿಮ್ಮದು ಯಾವ ರೀತಿಯ ವ್ಯಾಪಾರ?')
k('ob.import.title','Have a Google Maps link, Instagram or website?','क्या आपके पास Google Maps लिंक, Instagram या वेबसाइट है?','ನಿಮ್ಮ ಬಳಿ Google Maps ಲಿಂಕ್, Instagram ಅಥವಾ ವೆಬ್‌ಸೈಟ್ ಇದೆಯೇ?')
k('ob.import.sub','Paste it and Orbit will fill in what it can. You can check everything on the next screen.','इसे पेस्ट करें, Orbit जितना हो सके भर देगा। अगली स्क्रीन पर आप सब जाँच सकते हैं।','ಅದನ್ನು ಅಂಟಿಸಿ, Orbit ಸಾಧ್ಯವಾದಷ್ಟು ತುಂಬುತ್ತದೆ. ಮುಂದಿನ ಪರದೆಯಲ್ಲಿ ಎಲ್ಲವನ್ನೂ ಪರಿಶೀಲಿಸಬಹುದು.')
k('ob.import.placeholder','e.g. @mysalon or mysalon.in','जैसे @mysalon या mysalon.in','ಉದಾ. @mysalon ಅಥವಾ mysalon.in')
k('ob.import.find','Fill it in for me','मेरे लिए भर दो','ನನಗಾಗಿ ತುಂಬಿ')
k('ob.import.use','Use these details','ये जानकारी इस्तेमाल करें','ಈ ವಿವರಗಳನ್ನು ಬಳಸಿ')
k('ob.import.skip','Skip, I will type it','छोड़ें, मैं खुद लिखूँगा','ಬಿಡಿ, ನಾನೇ ಟೈಪ್ ಮಾಡುತ್ತೇನೆ')
k('ob.import.photos','{{count}} photos found','{{count}} फ़ोटो मिलीं','{{count}} ಫೋಟೋಗಳು ಸಿಕ್ಕಿವೆ')
k('ob.import.photos.one','1 photo found','1 फ़ोटो मिली','1 ಫೋಟೋ ಸಿಕ್ಕಿದೆ')
for f,(a,b,c) in {'name':('Name','नाम','ಹೆಸರು'),'phone':('Phone','फ़ोन','ಫೋನ್'),'address':('Address','पता','ವಿಳಾಸ'),'description':('About','परिचय','ಪರಿಚಯ'),'website':('Website','वेबसाइट','ವೆಬ್‌ಸೈಟ್'),'instagram':('Instagram','Instagram','Instagram')}.items():
  k(f'ob.import.field.{f}',a,b,c)
k('import.website_ok','We found these details on your website.','हमें आपकी वेबसाइट पर ये जानकारी मिली।','ನಿಮ್ಮ ವೆಬ್‌ಸೈಟ್‌ನಲ್ಲಿ ಈ ವಿವರಗಳು ಸಿಕ್ಕಿವೆ.')
k('import.website_failed','We could not read that website. No problem, you can type the details.','हम वह वेबसाइट नहीं पढ़ पाए। कोई बात नहीं, आप जानकारी लिख सकते हैं।','ಆ ವೆಬ್‌ಸೈಟ್ ಓದಲು ಆಗಲಿಲ್ಲ. ಪರವಾಗಿಲ್ಲ, ನೀವು ವಿವರಗಳನ್ನು ಟೈಪ್ ಮಾಡಬಹುದು.')
k('import.instagram_saved','We saved your Instagram link. Please type the rest on the next screen.','हमने आपका Instagram लिंक सेव कर लिया। बाकी अगली स्क्रीन पर लिखें।','ನಿಮ್ಮ Instagram ಲಿಂಕ್ ಉಳಿಸಲಾಗಿದೆ. ಉಳಿದದ್ದನ್ನು ಮುಂದಿನ ಪರದೆಯಲ್ಲಿ ಟೈಪ್ ಮಾಡಿ.')
k('import.maps_name_only','We found your business name. Please check the rest on the next screen.','हमें आपके बिज़नेस का नाम मिल गया। बाकी अगली स्क्रीन पर जाँचें।','ನಿಮ್ಮ ವ್ಯಾಪಾರದ ಹೆಸರು ಸಿಕ್ಕಿದೆ. ಉಳಿದದ್ದನ್ನು ಮುಂದಿನ ಪರದೆಯಲ್ಲಿ ಪರಿಶೀಲಿಸಿ.')
k('import.maps_link_saved','We could not read that map link. Please type your details on the next screen.','हम वह मैप लिंक नहीं पढ़ पाए। अगली स्क्रीन पर अपनी जानकारी लिखें।','ಆ ನಕ್ಷೆ ಲಿಂಕ್ ಓದಲು ಆಗಲಿಲ್ಲ. ಮುಂದಿನ ಪರದೆಯಲ್ಲಿ ವಿವರಗಳನ್ನು ಟೈಪ್ ಮಾಡಿ.')
k('import.unknown','That does not look like a link. Try a website, an Instagram handle like @mysalon, or a Google Maps link.','यह लिंक जैसा नहीं लगता। वेबसाइट, @mysalon जैसा Instagram हैंडल या Google Maps लिंक आज़माएँ।','ಇದು ಲಿಂಕ್‌ನಂತೆ ಕಾಣುತ್ತಿಲ್ಲ. ವೆಬ್‌ಸೈಟ್, @mysalon ರೀತಿಯ Instagram ಹ್ಯಾಂಡಲ್ ಅಥವಾ Google Maps ಲಿಂಕ್ ಪ್ರಯತ್ನಿಸಿ.')
k('ob.name.title','What is your business called?','आपके बिज़नेस का नाम क्या है?','ನಿಮ್ಮ ವ್ಯಾಪಾರದ ಹೆಸರೇನು?')
k('ob.name.label','Business name','बिज़नेस का नाम','ವ್ಯಾಪಾರದ ಹೆಸರು')
k('ob.name.phone','Business phone or WhatsApp','बिज़नेस फ़ोन या WhatsApp','ವ್ಯಾಪಾರದ ಫೋನ್ ಅಥವಾ WhatsApp')
k('ob.name.address','Address','पता','ವಿಳಾಸ')
k('ob.svc.title','What do you offer?','आप क्या-क्या सेवाएँ देते हैं?','ನೀವು ಏನೇನು ಸೇವೆ ನೀಡುತ್ತೀರಿ?')
k('ob.svc.sub','We filled in common ones. Change the prices to yours, or remove what you do not offer.','हमने आम सेवाएँ भर दी हैं। कीमतें अपनी डालें, या जो नहीं देते उसे हटा दें।','ಸಾಮಾನ್ಯ ಸೇವೆಗಳನ್ನು ತುಂಬಿದ್ದೇವೆ. ನಿಮ್ಮ ಬೆಲೆಗಳನ್ನು ಹಾಕಿ, ಅಥವಾ ನೀವು ನೀಡದ್ದನ್ನು ತೆಗೆದುಹಾಕಿ.')
k('ob.svc.name','Service','सेवा','ಸೇವೆ')
k('ob.svc.minutes','Minutes','मिनट','ನಿಮಿಷ')
k('ob.svc.price','Price (₹)','कीमत (₹)','ಬೆಲೆ (₹)')
k('ob.svc.ask','Ask','पूछें','ಕೇಳಿ')
k('ob.svc.add','Add a service','सेवा जोड़ें','ಸೇವೆ ಸೇರಿಸಿ')
k('ob.hours.title','When are you open?','आप कब खुले रहते हैं?','ನೀವು ಯಾವಾಗ ತೆರೆದಿರುತ್ತೀರಿ?')
k('ob.hours.sub','Orbit only offers times when you are open.','Orbit सिर्फ़ उन्हीं समय की बुकिंग देगा जब आप खुले हों।','ನೀವು ತೆರೆದಿರುವ ಸಮಯವನ್ನು ಮಾತ್ರ Orbit ನೀಡುತ್ತದೆ.')
k('ob.hours.open_on','Open on {{day}}','{{day}} को खुला','{{day}} ತೆರೆದಿದೆ')
k('ob.hours.from','Opens','खुलता है','ತೆರೆಯುತ್ತದೆ')
k('ob.hours.to','Closes','बंद होता है','ಮುಚ್ಚುತ್ತದೆ')
k('ob.hours.add_break','Add a break','ब्रेक जोड़ें','ವಿರಾಮ ಸೇರಿಸಿ')
k('ob.hours.copy_monday','Use Monday\'s hours for every weekday','सोमवार का समय सभी दिनों पर लगाएँ','ಸೋಮವಾರದ ಸಮಯವನ್ನು ಎಲ್ಲಾ ದಿನಗಳಿಗೆ ಬಳಸಿ')
k('ob.hours.invalid','Please check the times: closing must be after opening.','कृपया समय जाँचें: बंद होने का समय खुलने के बाद होना चाहिए।','ದಯವಿಟ್ಟು ಸಮಯ ಪರಿಶೀಲಿಸಿ: ಮುಚ್ಚುವ ಸಮಯ ತೆರೆಯುವ ಸಮಯದ ನಂತರ ಇರಬೇಕು.')
k('ob.staff.title','Who works with you?','आपके साथ कौन काम करता है?','ನಿಮ್ಮೊಂದಿಗೆ ಯಾರು ಕೆಲಸ ಮಾಡುತ್ತಾರೆ?')
k('ob.staff.sub','Add names so customers can pick a person. You can skip this.','नाम जोड़ें ताकि ग्राहक व्यक्ति चुन सकें। आप इसे छोड़ भी सकते हैं।','ಗ್ರಾಹಕರು ವ್ಯಕ್ತಿಯನ್ನು ಆಯ್ಕೆ ಮಾಡಲು ಹೆಸರುಗಳನ್ನು ಸೇರಿಸಿ. ಇದನ್ನು ಬಿಡಬಹುದು.')
k('ob.staff.name','Name','नाम','ಹೆಸರು')
k('ob.staff.just_me','It is just me','सिर्फ़ मैं हूँ','ನಾನೊಬ್ಬನೇ')
k('ob.cal.title','Which calendar should Orbit use?','Orbit कौन-सा कैलेंडर इस्तेमाल करे?','Orbit ಯಾವ ಕ್ಯಾಲೆಂಡರ್ ಬಳಸಬೇಕು?')
k('ob.cal.sub','Orbit books appointments only into free time.','Orbit सिर्फ़ खाली समय में अपॉइंटमेंट बुक करता है।','Orbit ಖಾಲಿ ಸಮಯದಲ್ಲಿ ಮಾತ್ರ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡುತ್ತದೆ.')
k('ob.cal.google','My Google Calendar','मेरा Google कैलेंडर','ನನ್ನ Google ಕ್ಯಾಲೆಂಡರ್')
k('ob.cal.builtin','Orbit\'s own calendar','Orbit का अपना कैलेंडर','Orbit ನ ಸ್ವಂತ ಕ್ಯಾಲೆಂಡರ್')
k('ob.cal.google_note','We will finish connecting Google Calendar from Powers. Until then Orbit uses its own calendar.','Google कैलेंडर को हम Powers से जोड़ेंगे। तब तक Orbit अपना कैलेंडर इस्तेमाल करेगा।','Google ಕ್ಯಾಲೆಂಡರ್ ಅನ್ನು Powers ನಿಂದ ಜೋಡಿಸುತ್ತೇವೆ. ಅಲ್ಲಿಯವರೆಗೆ Orbit ತನ್ನ ಕ್ಯಾಲೆಂಡರ್ ಬಳಸುತ್ತದೆ.')
k('ob.live.title','Your Orbit is live!','आपका Orbit चालू है!','ನಿಮ್ಮ Orbit ಚಾಲನೆಯಲ್ಲಿದೆ!')
k('ob.live.sub','Customers can now find {{business}}, see your prices and talk to Orbit.','अब ग्राहक {{business}} को ढूँढ सकते हैं, आपकी कीमतें देख सकते हैं और Orbit से बात कर सकते हैं।','ಈಗ ಗ್ರಾಹಕರು {{business}} ಅನ್ನು ಹುಡುಕಬಹುದು, ನಿಮ್ಮ ಬೆಲೆಗಳನ್ನು ನೋಡಬಹುದು ಮತ್ತು Orbit ಜೊತೆ ಮಾತನಾಡಬಹುದು.')
k('ob.live.almost','Almost there. One tap to go live.','बस हो गया। चालू करने के लिए एक टैप।','ಬಹುತೇಕ ಮುಗಿಯಿತು. ಚಾಲೂ ಮಾಡಲು ಒಂದು ಟ್ಯಾಪ್.')
k('ob.live.go_live','Go live','चालू करें','ಚಾಲೂ ಮಾಡಿ')
k('ob.live.link','Your page','आपका पेज','ನಿಮ್ಮ ಪುಟ')
k('ob.live.share_whatsapp','Share on WhatsApp','WhatsApp पर भेजें','WhatsApp ನಲ್ಲಿ ಹಂಚಿಕೊಳ್ಳಿ')
k('ob.live.share_text','Book with {{business}} online: {{url}}','{{business}} के साथ ऑनलाइन बुक करें: {{url}}','{{business}} ಜೊತೆ ಆನ್‌ಲೈನ್‌ನಲ್ಲಿ ಬುಕ್ ಮಾಡಿ: {{url}}')
k('ob.live.test','Test your Orbit','अपना Orbit आज़माएँ','ನಿಮ್ಮ Orbit ಪರೀಕ್ಷಿಸಿ')
k('ob.live.qr','QR code for your shop','दुकान के लिए QR कोड','ನಿಮ್ಮ ಅಂಗಡಿಗೆ QR ಕೋಡ್')
k('ob.live.qr_sub','Print it and put it at your counter. Customers scan it to book or chat.','इसे प्रिंट करके काउंटर पर लगाएँ। ग्राहक स्कैन करके बुक या चैट कर सकते हैं।','ಇದನ್ನು ಮುದ್ರಿಸಿ ಕೌಂಟರ್‌ನಲ್ಲಿ ಇಡಿ. ಗ್ರಾಹಕರು ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ಬುಕ್ ಅಥವಾ ಚಾಟ್ ಮಾಡಬಹುದು.')
k('ob.live.qr_print','Scan to book or chat with us','बुक या चैट करने के लिए स्कैन करें','ಬುಕ್ ಅಥವಾ ಚಾಟ್ ಮಾಡಲು ಸ್ಕ್ಯಾನ್ ಮಾಡಿ')
k('ob.live.print','Print','प्रिंट करें','ಮುದ್ರಿಸಿ')
k('ob.live.widget','Add chat to your website','अपनी वेबसाइट पर चैट जोड़ें','ನಿಮ್ಮ ವೆಬ್‌ಸೈಟ್‌ಗೆ ಚಾಟ್ ಸೇರಿಸಿ')
k('ob.live.widget_sub','Send this to whoever looks after your website. They paste it once.','इसे अपनी वेबसाइट देखने वाले को भेजें। उन्हें इसे एक बार पेस्ट करना है।','ನಿಮ್ಮ ವೆಬ್‌ಸೈಟ್ ನೋಡಿಕೊಳ್ಳುವವರಿಗೆ ಇದನ್ನು ಕಳುಹಿಸಿ. ಅವರು ಒಮ್ಮೆ ಅಂಟಿಸಿದರೆ ಸಾಕು.')
k('ob.live.to_bridge','Go to The Bridge','The Bridge पर जाएँ','The Bridge ಗೆ ಹೋಗಿ')

# checklist
k('check.title','Make Orbit stronger','Orbit को और मज़बूत बनाएँ','Orbit ಅನ್ನು ಇನ್ನಷ್ಟು ಬಲಪಡಿಸಿ')
k('check.sub','{{count}} optional steps left. Do them any time.','{{count}} वैकल्पिक कदम बाकी हैं। जब चाहें करें।','{{count}} ಐಚ್ಛಿಕ ಹಂತಗಳು ಉಳಿದಿವೆ. ಯಾವಾಗ ಬೇಕಾದರೂ ಮಾಡಿ.')
k('check.sub.one','1 optional step left. Do it any time.','1 वैकल्पिक कदम बाकी है। जब चाहें करें।','1 ಐಚ್ಛಿಕ ಹಂತ ಉಳಿದಿದೆ. ಯಾವಾಗ ಬೇಕಾದರೂ ಮಾಡಿ.')
cl = {
 'whatsapp':(('Connect WhatsApp','Aria replies to WhatsApp messages for you. Setup with Meta takes a few days; we guide you.'),('WhatsApp जोड़ें','Aria आपके लिए WhatsApp संदेशों का जवाब देगी। Meta के साथ सेटअप में कुछ दिन लगते हैं; हम मदद करेंगे।'),('WhatsApp ಜೋಡಿಸಿ','Aria ನಿಮ್ಮ ಪರವಾಗಿ WhatsApp ಸಂದೇಶಗಳಿಗೆ ಉತ್ತರಿಸುತ್ತಾಳೆ. Meta ಜೊತೆ ಸೆಟಪ್‌ಗೆ ಕೆಲವು ದಿನ ಬೇಕು; ನಾವು ಸಹಾಯ ಮಾಡುತ್ತೇವೆ.')),
 'instagram':(('Connect Instagram','Answer DMs and comments automatically.'),('Instagram जोड़ें','DM और कमेंट का अपने-आप जवाब।'),('Instagram ಜೋಡಿಸಿ','DM ಮತ್ತು ಕಾಮೆಂಟ್‌ಗಳಿಗೆ ತಾನಾಗಿಯೇ ಉತ್ತರ.')),
 'gmail':(('Connect Gmail','Orbit reads enquiry emails and replies from your address.'),('Gmail जोड़ें','Orbit पूछताछ वाले ईमेल पढ़कर आपके पते से जवाब देगा।'),('Gmail ಜೋಡಿಸಿ','Orbit ವಿಚಾರಣೆ ಇಮೇಲ್‌ಗಳನ್ನು ಓದಿ ನಿಮ್ಮ ವಿಳಾಸದಿಂದ ಉತ್ತರಿಸುತ್ತದೆ.')),
 'voice':(('Turn on phone calls','Vox answers calls 24/7 and calls customers back.'),('फ़ोन कॉल चालू करें','Vox 24/7 कॉल का जवाब देगा और ग्राहकों को वापस कॉल करेगा।'),('ಫೋನ್ ಕರೆಗಳನ್ನು ಆನ್ ಮಾಡಿ','Vox 24/7 ಕರೆಗಳಿಗೆ ಉತ್ತರಿಸುತ್ತದೆ ಮತ್ತು ಗ್ರಾಹಕರಿಗೆ ಮರಳಿ ಕರೆ ಮಾಡುತ್ತದೆ.')),
 'payments':(('Add payment details','Send UPI and card payment links.'),('पेमेंट जानकारी जोड़ें','UPI और कार्ड पेमेंट लिंक भेजें।'),('ಪಾವತಿ ವಿವರ ಸೇರಿಸಿ','UPI ಮತ್ತು ಕಾರ್ಡ್ ಪಾವತಿ ಲಿಂಕ್‌ಗಳನ್ನು ಕಳುಹಿಸಿ.')),
 'faqs':(('Add your own FAQs','The more Orbit knows, the fewer questions come to you.'),('अपने FAQ जोड़ें','Orbit जितना ज़्यादा जानेगा, आपके पास उतने कम सवाल आएँगे।'),('ನಿಮ್ಮ FAQ ಸೇರಿಸಿ','Orbit ಹೆಚ್ಚು ತಿಳಿದಷ್ಟೂ ನಿಮಗೆ ಕಡಿಮೆ ಪ್ರಶ್ನೆಗಳು ಬರುತ್ತವೆ.')),
 'price_list':(('Upload a price list','A photo or PDF is enough.'),('रेट लिस्ट अपलोड करें','एक फ़ोटो या PDF काफ़ी है।'),('ದರ ಪಟ್ಟಿ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ','ಒಂದು ಫೋಟೋ ಅಥವಾ PDF ಸಾಕು.')),
 'invite_staff':(('Invite your staff','They manage their own calendar and chats.'),('अपने स्टाफ़ को बुलाएँ','वे अपना कैलेंडर और चैट खुद संभालेंगे।'),('ನಿಮ್ಮ ಸಿಬ್ಬಂದಿಯನ್ನು ಆಹ್ವಾನಿಸಿ','ಅವರು ತಮ್ಮ ಕ್ಯಾಲೆಂಡರ್ ಮತ್ತು ಚಾಟ್‌ಗಳನ್ನು ನಿರ್ವಹಿಸುತ್ತಾರೆ.')),
 'meet_crew':(('Meet the Crew','See what Aria, Vox, Nudge, Ledger and Spark can do.'),('Crew से मिलें','देखें Aria, Vox, Nudge, Ledger और Spark क्या कर सकते हैं।'),('Crew ಅನ್ನು ಭೇಟಿಯಾಗಿ','Aria, Vox, Nudge, Ledger ಮತ್ತು Spark ಏನು ಮಾಡಬಲ್ಲರು ನೋಡಿ.')),
}
for key,(e,h,n) in cl.items():
  k(f'check.{key}',e[0],h[0],n[0]); k(f'check.{key}.why',e[1],h[1],n[1])

# bridge
k('bridge.admin','Admin','एडमिन','ಆಡ್ಮಿನ್')
k('bridge.sign_out','Sign out','साइन आउट','ಸೈನ್ ಔಟ್')
k('bridge.views','Views','व्यू','ವೀಕ್ಷಣೆಗಳು')
k('bridge.pull','Pull to refresh','रीफ़्रेश के लिए नीचे खींचें','ರಿಫ್ರೆಶ್ ಮಾಡಲು ಎಳೆಯಿರಿ')
k('bridge.release','Release to refresh','रीफ़्रेश के लिए छोड़ें','ರಿಫ್ರೆಶ್ ಮಾಡಲು ಬಿಡಿ')
k('bridge.impersonating','You are viewing this business as its owner. Everything you do is recorded.','आप यह बिज़नेस मालिक के रूप में देख रहे हैं। आपका हर कदम रिकॉर्ड होता है।','ನೀವು ಈ ವ್ಯಾಪಾರವನ್ನು ಮಾಲೀಕರಾಗಿ ನೋಡುತ್ತಿದ್ದೀರಿ. ನೀವು ಮಾಡುವ ಎಲ್ಲವೂ ದಾಖಲಾಗುತ್ತದೆ.')
k('bridge.stop_viewing','Stop viewing','देखना बंद करें','ನೋಡುವುದನ್ನು ನಿಲ್ಲಿಸಿ')
k('bridge.morning','Good morning. Here is your day.','सुप्रभात। यह रहा आपका आज का दिन।','ಶುಭೋದಯ. ಇದು ನಿಮ್ಮ ಇಂದಿನ ದಿನ.')
k('bridge.evening','Here is how today went.','आज का दिन ऐसा रहा।','ಇಂದಿನ ದಿನ ಹೀಗಿತ್ತು.')
k('zone.pulse','Business Pulse','बिज़नेस पल्स','ವ್ಯಾಪಾರ ಪಲ್ಸ್')
k('zone.needs_you','Needs you','आपकी ज़रूरत है','ನಿಮ್ಮ ಅಗತ್ಯವಿದೆ')
k('zone.feed','What the Crew did','Crew ने क्या किया','Crew ಏನು ಮಾಡಿತು')
k('zone.earnings','Orbit Earnings this month','इस महीने Orbit की कमाई','ಈ ತಿಂಗಳ Orbit ಗಳಿಕೆ')
k('pulse.score_label','Business Pulse {{score}} out of 100','बिज़नेस पल्स 100 में से {{score}}','ವ್ಯಾಪಾರ ಪಲ್ಸ್ 100 ರಲ್ಲಿ {{score}}')
k('pulse.label.money_today','money today','आज की कमाई','ಇಂದಿನ ಹಣ')
k('pulse.label.bookings_today','bookings today','आज की बुकिंग','ಇಂದಿನ ಬುಕಿಂಗ್')
k('pulse.label.people_waiting','people waiting','लोग इंतज़ार में','ಕಾಯುತ್ತಿರುವವರು')
k('pulse.strong_more','Strong day. {{diff}} more bookings than a usual {{weekday}}.','बढ़िया दिन। आम {{weekday}} से {{diff}} बुकिंग ज़्यादा।','ಉತ್ತಮ ದಿನ. ಸಾಮಾನ್ಯ {{weekday}} ಗಿಂತ {{diff}} ಬುಕಿಂಗ್ ಹೆಚ್ಚು.')
k('pulse.strong_more.one','Good day. 1 more booking than a usual {{weekday}}.','अच्छा दिन। आम {{weekday}} से 1 बुकिंग ज़्यादा।','ಒಳ್ಳೆಯ ದಿನ. ಸಾಮಾನ್ಯ {{weekday}} ಗಿಂತ 1 ಬುಕಿಂಗ್ ಹೆಚ್ಚು.')
k('pulse.quiet_fewer','Quieter than a usual {{weekday}}: {{diff}} fewer bookings so far.','आम {{weekday}} से शांत: अब तक {{diff}} बुकिंग कम।','ಸಾಮಾನ್ಯ {{weekday}} ಗಿಂತ ನಿಧಾನ: ಇಲ್ಲಿಯವರೆಗೆ {{diff}} ಬುಕಿಂಗ್ ಕಡಿಮೆ.')
k('pulse.steady','A steady day, just like a usual {{weekday}}.','एक सामान्य दिन, आम {{weekday}} जैसा।','ಸ್ಥಿರ ದಿನ, ಸಾಮಾನ್ಯ {{weekday}} ನಂತೆಯೇ.')
k('pulse.bad_review','A bad review needs your reply. Everything else is on track.','एक खराब रिव्यू को आपके जवाब की ज़रूरत है। बाकी सब ठीक चल रहा है।','ಒಂದು ಕೆಟ್ಟ ವಿಮರ್ಶೆಗೆ ನಿಮ್ಮ ಉತ್ತರ ಬೇಕು. ಉಳಿದೆಲ್ಲವೂ ಸರಿಯಾಗಿದೆ.')
k('pulse.bad_review.one','A bad review needs your reply. Everything else is on track.','एक खराब रिव्यू को आपके जवाब की ज़रूरत है। बाकी सब ठीक चल रहा है।','ಒಂದು ಕೆಟ್ಟ ವಿಮರ್ಶೆಗೆ ನಿಮ್ಮ ಉತ್ತರ ಬೇಕು. ಉಳಿದೆಲ್ಲವೂ ಸರಿಯಾಗಿದೆ.')
k('pulse.no_history','Your first days with Orbit. The Pulse gets smarter every day.','Orbit के साथ आपके शुरुआती दिन। पल्स हर दिन और समझदार होता जाएगा।','Orbit ಜೊತೆ ನಿಮ್ಮ ಮೊದಲ ದಿನಗಳು. ಪಲ್ಸ್ ಪ್ರತಿದಿನ ಇನ್ನಷ್ಟು ಜಾಣವಾಗುತ್ತದೆ.')
k('pulse.people_waiting','{{count}} people are waiting for a reply.','{{count}} लोग जवाब का इंतज़ार कर रहे हैं।','{{count}} ಜನರು ಉತ್ತರಕ್ಕಾಗಿ ಕಾಯುತ್ತಿದ್ದಾರೆ.')
k('needs.count','{{count}} to decide','{{count}} फ़ैसले बाकी','{{count}} ನಿರ್ಧಾರಗಳು ಬಾಕಿ')
k('needs.count.one','1 to decide','1 फ़ैसला बाकी','1 ನಿರ್ಧಾರ ಬಾಕಿ')
k('needs.empty','Nothing needs you. Orbit has it handled.','अभी आपकी ज़रूरत नहीं। Orbit सब संभाल रहा है।','ಈಗ ನಿಮ್ಮ ಅಗತ್ಯವಿಲ್ಲ. Orbit ಎಲ್ಲವನ್ನೂ ನೋಡಿಕೊಳ್ಳುತ್ತಿದೆ.')
k('needs.suggested','Suggested reply','सुझाया गया जवाब','ಸೂಚಿಸಿದ ಉತ್ತರ')
k('needs.sample','Message','संदेश','ಸಂದೇಶ')
k('card.discount','{{customer}} asked for a discount. Offer {{percent}}%?','{{customer}} ने छूट माँगी है। {{percent}}% दें?','{{customer}} ರಿಯಾಯಿತಿ ಕೇಳಿದ್ದಾರೆ. {{percent}}% ನೀಡಬೇಕೇ?')
k('card.campaign','{{agent}} drafted a {{occasion}} offer for {{count}} customers. Send?','{{agent}} ने {{count}} ग्राहकों के लिए {{occasion}} ऑफ़र तैयार किया है। भेजें?','{{agent}} {{count}} ಗ್ರಾಹಕರಿಗೆ {{occasion}} ಆಫರ್ ತಯಾರಿಸಿದೆ. ಕಳುಹಿಸಬೇಕೇ?')
k('card.bad_review','Bad review from {{customer}}. Suggested reply ready.','{{customer}} का खराब रिव्यू। जवाब तैयार है।','{{customer}} ಅವರಿಂದ ಕೆಟ್ಟ ವಿಮರ್ಶೆ. ಉತ್ತರ ಸಿದ್ಧವಿದೆ.')
k('card.unknown_answer','{{customer}} asked something Orbit does not know: “{{question}}”','{{customer}} ने कुछ ऐसा पूछा जो Orbit नहीं जानता: “{{question}}”','{{customer}} Orbit ಗೆ ತಿಳಿಯದ ಪ್ರಶ್ನೆ ಕೇಳಿದ್ದಾರೆ: “{{question}}”')
for o,(a,b,c) in {'yes':('Yes','हाँ','ಹೌದು'),'no':('No','नहीं','ಬೇಡ'),'reply_myself':('Reply myself','खुद जवाब दूँगा','ನಾನೇ ಉತ್ತರಿಸುತ್ತೇನೆ'),'send':('Send','भेजें','ಕಳುಹಿಸಿ'),'edit':('Edit','बदलें','ಬದಲಿಸಿ'),'post':('Post','पोस्ट करें','ಪೋಸ್ಟ್ ಮಾಡಿ'),'answer':('Answer','जवाब दें','ಉತ್ತರಿಸಿ')}.items():
  k(f'card.option.{o}',a,b,c)

# feed
k('feed.empty','The Crew will show what they do here.','Crew जो भी करेगा, यहाँ दिखेगा।','Crew ಮಾಡುವ ಕೆಲಸ ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತದೆ.')
k('feed.aria.booked','{{agent}} booked {{customer}} for {{service}} at {{time}} (from {{channel}})','{{agent}} ने {{customer}} की {{service}} {{time}} बजे बुक की ({{channel}} से)','{{agent}} {{customer}} ಅವರಿಗೆ {{time}} ಕ್ಕೆ {{service}} ಬುಕ್ ಮಾಡಿದೆ ({{channel}} ಮೂಲಕ)')
k('feed.aria.answered','{{agent}} answered {{customer}}\'s question about {{topic}}','{{agent}} ने {{customer}} के {{topic}} वाले सवाल का जवाब दिया','{{agent}} {{customer}} ಅವರ {{topic}} ಕುರಿತ ಪ್ರಶ್ನೆಗೆ ಉತ್ತರಿಸಿದೆ')
k('feed.aria.lead','{{agent}} found a new lead: {{customer}}, interested in {{interest}}','{{agent}} को नया लीड मिला: {{customer}}, {{interest}} में रुचि','{{agent}} ಹೊಸ ಲೀಡ್ ಕಂಡುಕೊಂಡಿದೆ: {{customer}}, {{interest}} ನಲ್ಲಿ ಆಸಕ್ತಿ')
k('feed.aria.handover','{{agent}} passed {{customer}} to you — they want to talk to a person','{{agent}} ने {{customer}} को आपके पास भेजा — वे किसी इंसान से बात करना चाहते हैं','{{agent}} {{customer}} ಅವರನ್ನು ನಿಮಗೆ ಒಪ್ಪಿಸಿದೆ — ಅವರು ವ್ಯಕ್ತಿಯೊಂದಿಗೆ ಮಾತನಾಡಲು ಬಯಸುತ್ತಾರೆ')
k('feed.vox.called_batch','{{agent}} called {{count}} members expiring this week. {{renewed}} renewed.','{{agent}} ने इस हफ़्ते खत्म होने वाले {{count}} मेंबर्स को कॉल किया। {{renewed}} ने रिन्यू किया।','{{agent}} ಈ ವಾರ ಮುಗಿಯುವ {{count}} ಸದಸ್ಯರಿಗೆ ಕರೆ ಮಾಡಿದೆ. {{renewed}} ನವೀಕರಿಸಿದರು.')
k('feed.ledger.collected','{{agent}} collected {{amount}} from {{count}} pending invoices.','{{agent}} ने {{count}} बकाया बिलों से {{amount}} वसूले।','{{agent}} {{count}} ಬಾಕಿ ಬಿಲ್‌ಗಳಿಂದ {{amount}} ಸಂಗ್ರಹಿಸಿದೆ.')
k('feed.nudge.reminders','{{agent}} sent {{count}} appointment reminders','{{agent}} ने {{count}} अपॉइंटमेंट रिमाइंडर भेजे','{{agent}} {{count}} ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಜ್ಞಾಪನೆಗಳನ್ನು ಕಳುಹಿಸಿದೆ')
k('feed.nudge.renewals','{{agent}} sent {{count}} renewal reminders','{{agent}} ने {{count}} रिन्यूअल रिमाइंडर भेजे','{{agent}} {{count}} ನವೀಕರಣ ಜ್ಞಾಪನೆಗಳನ್ನು ಕಳುಹಿಸಿದೆ')
k('feed.nudge.review_request','{{agent}} asked {{customer}} for a review','{{agent}} ने {{customer}} से रिव्यू माँगा','{{agent}} {{customer}} ಅವರಿಂದ ವಿಮರ್ಶೆ ಕೇಳಿದೆ')
k('feed.spark.drafted','{{agent}} drafted a {{occasion}} offer for {{count}} customers','{{agent}} ने {{count}} ग्राहकों के लिए {{occasion}} ऑफ़र तैयार किया','{{agent}} {{count}} ಗ್ರಾಹಕರಿಗೆ {{occasion}} ಆಫರ್ ತಯಾರಿಸಿದೆ')
k('feed.orbit.setup_started','You started setting up Orbit','आपने Orbit सेट करना शुरू किया','ನೀವು Orbit ಸೆಟಪ್ ಪ್ರಾರಂಭಿಸಿದಿರಿ')
k('feed.orbit.live','{{business}} is live on Orbit. Customers can now book and chat.','{{business}} अब Orbit पर चालू है। ग्राहक अब बुक और चैट कर सकते हैं।','{{business}} ಈಗ Orbit ನಲ್ಲಿ ಚಾಲನೆಯಲ್ಲಿದೆ. ಗ್ರಾಹಕರು ಈಗ ಬುಕ್ ಮತ್ತು ಚಾಟ್ ಮಾಡಬಹುದು.')
k('feed.orbit.card_approved','You said yes. {{agent}} will take it from here.','आपने हाँ कहा। अब {{agent}} आगे संभालेगा।','ನೀವು ಹೌದು ಎಂದಿರಿ. ಇನ್ನು {{agent}} ನೋಡಿಕೊಳ್ಳುತ್ತದೆ.')
k('feed.orbit.card_rejected','You said no. {{agent}} will not go ahead.','आपने ना कहा। {{agent}} आगे नहीं बढ़ेगा।','ನೀವು ಬೇಡ ಎಂದಿರಿ. {{agent}} ಮುಂದುವರಿಯುವುದಿಲ್ಲ.')
k('feed.orbit.card_edited','You are handling this one yourself.','यह आप खुद संभाल रहे हैं।','ಇದನ್ನು ನೀವೇ ನೋಡಿಕೊಳ್ಳುತ್ತಿದ್ದೀರಿ.')
k('feed.orbit.card_expired','A decision waited too long, so Orbit played it safe and did nothing.','एक फ़ैसला बहुत देर तक रुका रहा, इसलिए Orbit ने सुरक्षित रहते हुए कुछ नहीं किया।','ಒಂದು ನಿರ್ಧಾರ ತುಂಬಾ ಹೊತ್ತು ಕಾಯಿತು, ಹಾಗಾಗಿ Orbit ಸುರಕ್ಷಿತವಾಗಿ ಏನೂ ಮಾಡಲಿಲ್ಲ.')
k('feed.orbit.command_received','Orbit noted your request','Orbit ने आपका अनुरोध नोट किया','Orbit ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಗಮನಿಸಿದೆ')
k('feed.group.booking_created','{{agent}} booked {{count}} appointments','{{agent}} ने {{count}} अपॉइंटमेंट बुक किए','{{agent}} {{count}} ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗಳನ್ನು ಬುಕ್ ಮಾಡಿದೆ')
k('feed.group.question_answered','{{agent}} answered {{count}} questions','{{agent}} ने {{count}} सवालों के जवाब दिए','{{agent}} {{count}} ಪ್ರಶ್ನೆಗಳಿಗೆ ಉತ್ತರಿಸಿದೆ')
k('feed.group.reminder_sent','{{agent}} sent reminders {{count}} times','{{agent}} ने {{count}} बार रिमाइंडर भेजे','{{agent}} {{count}} ಬಾರಿ ಜ್ಞಾಪನೆ ಕಳುಹಿಸಿದೆ')
k('feed.group.payment_received','{{agent}} recorded {{count}} payments','{{agent}} ने {{count}} पेमेंट दर्ज किए','{{agent}} {{count}} ಪಾವತಿಗಳನ್ನು ದಾಖಲಿಸಿದೆ')
k('feed.group.review_request_sent','{{agent}} asked {{count}} customers for reviews','{{agent}} ने {{count}} ग्राहकों से रिव्यू माँगे','{{agent}} {{count}} ಗ್ರಾಹಕರಿಂದ ವಿಮರ್ಶೆ ಕೇಳಿದೆ')
k('feed.group.lead_captured','{{agent}} found {{count}} new leads','{{agent}} को {{count}} नए लीड मिले','{{agent}} {{count}} ಹೊಸ ಲೀಡ್‌ಗಳನ್ನು ಕಂಡುಕೊಂಡಿದೆ')
k('earn.sub','brought in by the Crew · {{count}} hours saved','Crew द्वारा लाए गए · {{count}} घंटे बचे','Crew ತಂದದ್ದು · {{count}} ಗಂಟೆ ಉಳಿತಾಯ')
k('earn.sub.one','brought in by the Crew · 1 hour saved','Crew द्वारा लाए गए · 1 घंटा बचा','Crew ತಂದದ್ದು · 1 ಗಂಟೆ ಉಳಿತಾಯ')

# briefing
k('brief.bookings_today','{{count}} bookings today.','आज {{count}} बुकिंग हैं।','ಇಂದು {{count}} ಬುಕಿಂಗ್‌ಗಳಿವೆ.')
k('brief.bookings_today.one','1 booking today.','आज 1 बुकिंग है।','ಇಂದು 1 ಬುಕಿಂಗ್ ಇದೆ.')
k('brief.next_booking','Next one at {{time}}.','अगली {{time}} बजे।','ಮುಂದಿನದು {{time}} ಕ್ಕೆ.')
k('brief.money_yesterday','Yesterday you collected {{amount}}.','कल आपने {{amount}} कमाए।','ನಿನ್ನೆ ನೀವು {{amount}} ಸಂಗ್ರಹಿಸಿದಿರಿ.')
k('brief.leads_yesterday','{{count}} new enquiries came in yesterday.','कल {{count}} नई पूछताछ आई।','ನಿನ್ನೆ {{count}} ಹೊಸ ವಿಚಾರಣೆಗಳು ಬಂದವು.')
k('brief.leads_yesterday.one','1 new enquiry came in yesterday.','कल 1 नई पूछताछ आई।','ನಿನ್ನೆ 1 ಹೊಸ ವಿಚಾರಣೆ ಬಂದಿತು.')
k('brief.unpaid','{{count}} invoices are unpaid ({{amount}}).','{{count}} बिल बकाया हैं ({{amount}})।','{{count}} ಬಿಲ್‌ಗಳು ಬಾಕಿ ಇವೆ ({{amount}}).')
k('brief.unpaid.one','1 invoice is unpaid ({{amount}}).','1 बिल बकाया है ({{amount}})।','1 ಬಿಲ್ ಬಾಕಿ ಇದೆ ({{amount}}).')
k('brief.completed_today','{{count}} appointments done today.','आज {{count}} अपॉइंटमेंट पूरे हुए।','ಇಂದು {{count}} ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗಳು ಮುಗಿದವು.')
k('brief.completed_today.one','1 appointment done today.','आज 1 अपॉइंटमेंट पूरा हुआ।','ಇಂದು 1 ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಮುಗಿಯಿತು.')
k('brief.money_today','You collected {{amount}} today.','आज आपने {{amount}} कमाए।','ಇಂದು ನೀವು {{amount}} ಸಂಗ್ರಹಿಸಿದಿರಿ.')
k('brief.leads_today','{{count}} new enquiries today.','आज {{count}} नई पूछताछ।','ಇಂದು {{count}} ಹೊಸ ವಿಚಾರಣೆಗಳು.')
k('brief.leads_today.one','1 new enquiry today.','आज 1 नई पूछताछ।','ಇಂದು 1 ಹೊಸ ವಿಚಾರಣೆ.')
k('brief.no_shows','{{count}} people did not show up.','{{count}} लोग नहीं आए।','{{count}} ಜನರು ಬರಲಿಲ್ಲ.')
k('brief.no_shows.one','1 person did not show up.','1 व्यक्ति नहीं आया।','1 ವ್ಯಕ್ತಿ ಬರಲಿಲ್ಲ.')

# command bar
k('cmd.placeholder','Ask or tell Orbit anything','Orbit से कुछ भी पूछें या कहें','Orbit ಗೆ ಏನನ್ನಾದರೂ ಕೇಳಿ ಅಥವಾ ಹೇಳಿ')
k('cmd.listening','Listening…','सुन रहा है…','ಆಲಿಸುತ್ತಿದೆ…')
k('cmd.hold','Hold to speak','बोलने के लिए दबाकर रखें','ಮಾತನಾಡಲು ಒತ್ತಿ ಹಿಡಿಯಿರಿ')
k('cmd.send','Send','भेजें','ಕಳುಹಿಸಿ')
k('command.received','Got it. Orbit has noted this and will act on requests like this once the Crew is fully switched on.','समझ गया। Orbit ने इसे नोट कर लिया है और Crew पूरी तरह चालू होते ही ऐसे अनुरोधों पर काम करेगा।','ಅರ್ಥವಾಯಿತು. Orbit ಇದನ್ನು ಗಮನಿಸಿದೆ, Crew ಪೂರ್ಣವಾಗಿ ಚಾಲೂ ಆದ ತಕ್ಷಣ ಇಂತಹ ವಿನಂತಿಗಳ ಮೇಲೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ.')
k('suggest.today_look','What does today look like?','आज का दिन कैसा है?','ಇಂದಿನ ದಿನ ಹೇಗಿದೆ?')
k('suggest.who_unpaid','Who has not paid?','किसने पेमेंट नहीं किया?','ಯಾರು ಪಾವತಿಸಿಲ್ಲ?')
k('suggest.new_customers_month','How many new customers this month?','इस महीने कितने नए ग्राहक आए?','ಈ ತಿಂಗಳು ಎಷ್ಟು ಹೊಸ ಗ್ರಾಹಕರು?')
k('suggest.how_today','How did today go?','आज का दिन कैसा रहा?','ಇಂದಿನ ದಿನ ಹೇಗಿತ್ತು?')
k('suggest.tomorrow_bookings','What is booked for tomorrow?','कल के लिए क्या बुक है?','ನಾಳೆಗೆ ಏನು ಬುಕ್ ಆಗಿದೆ?')

# views
for v,(a,b,c) in {'bridge':('The Bridge','The Bridge','The Bridge'),'crew':('Crew','Crew','Crew'),'people':('People','लोग','ಜನರು'),'tomorrow':('Tomorrow','कल','ನಾಳೆ'),'rewind':('Rewind','रिवाइंड','ರಿವೈಂಡ್'),'powers':('Powers','Powers','Powers'),'details':('Details','विवरण','ವಿವರಗಳು')}.items():
  k(f'view.{v}',a,b,c)
k('coming.tomorrow','Soon Orbit will show tomorrow\'s expected bookings, empty slots and ideas to fill them.','जल्द ही Orbit कल की अनुमानित बुकिंग, खाली स्लॉट और उन्हें भरने के आइडिया दिखाएगा।','ಶೀಘ್ರದಲ್ಲೇ Orbit ನಾಳೆಯ ನಿರೀಕ್ಷಿತ ಬುಕಿಂಗ್, ಖಾಲಿ ಸ್ಲಾಟ್‌ಗಳು ಮತ್ತು ಅವುಗಳನ್ನು ತುಂಬುವ ಆಲೋಚನೆಗಳನ್ನು ತೋರಿಸುತ್ತದೆ.')
k('coming.rewind','Soon you can replay any past day and see every enquiry, booking, call and payment as it happened.','जल्द ही आप कोई भी बीता दिन दोबारा देख पाएँगे — हर पूछताछ, बुकिंग, कॉल और पेमेंट।','ಶೀಘ್ರದಲ್ಲೇ ಯಾವುದೇ ಹಿಂದಿನ ದಿನವನ್ನು ಮತ್ತೆ ನೋಡಬಹುದು — ಪ್ರತಿ ವಿಚಾರಣೆ, ಬುಕಿಂಗ್, ಕರೆ ಮತ್ತು ಪಾವತಿ.')
k('crew.sub','Your team of helpers. Orbit gives them work and checks it.','आपकी मददगार टीम। Orbit इन्हें काम देता है और जाँचता है।','ನಿಮ್ಮ ಸಹಾಯಕರ ತಂಡ. Orbit ಅವರಿಗೆ ಕೆಲಸ ಕೊಟ್ಟು ಪರಿಶೀಲಿಸುತ್ತದೆ.')
k('crew.on','Working','काम पर','ಕೆಲಸದಲ್ಲಿದೆ')
k('crew.off','Not on your plan','आपके प्लान में नहीं','ನಿಮ್ಮ ಪ್ಲಾನ್‌ನಲ್ಲಿ ಇಲ್ಲ')
k('crew.done_today','{{count}} things done today','आज {{count}} काम किए','ಇಂದು {{count}} ಕೆಲಸ ಮಾಡಿದೆ')
k('crew.done_today.one','1 thing done today','आज 1 काम किया','ಇಂದು 1 ಕೆಲಸ ಮಾಡಿದೆ')
k('crew.upgrade','Upgrade to switch on','चालू करने के लिए अपग्रेड करें','ಆನ್ ಮಾಡಲು ಅಪ್‌ಗ್ರೇಡ್ ಮಾಡಿ')
for a,(e,h,n) in {
 'orbit':('Manager — plans the work and briefs you','मैनेजर — काम की योजना बनाता है और आपको बताता है','ಮ್ಯಾನೇಜರ್ — ಕೆಲಸ ಯೋಜಿಸಿ ನಿಮಗೆ ತಿಳಿಸುತ್ತದೆ'),
 'aria':('Front desk — answers and books','फ़्रंट डेस्क — जवाब देती है और बुक करती है','ಫ್ರಂಟ್ ಡೆಸ್ಕ್ — ಉತ್ತರಿಸಿ ಬುಕ್ ಮಾಡುತ್ತಾಳೆ'),
 'vox':('Voice — answers and makes calls','वॉइस — कॉल उठाता और करता है','ಧ್ವನಿ — ಕರೆ ಸ್ವೀಕರಿಸಿ ಮಾಡುತ್ತದೆ'),
 'nudge':('Retention — reminders and follow-ups','रिटेंशन — रिमाइंडर और फ़ॉलो-अप','ಉಳಿಸಿಕೊಳ್ಳುವಿಕೆ — ಜ್ಞಾಪನೆ ಮತ್ತು ಫಾಲೋ-ಅಪ್'),
 'ledger':('Money — invoices and payments','पैसा — बिल और पेमेंट','ಹಣ — ಬಿಲ್ ಮತ್ತು ಪಾವತಿ'),
 'spark':('Growth — offers and social posts','ग्रोथ — ऑफ़र और सोशल पोस्ट','ಬೆಳವಣಿಗೆ — ಆಫರ್ ಮತ್ತು ಸೋಶಿಯಲ್ ಪೋಸ್ಟ್'),
}.items():
  k(f'agent.{a}.role',e,h,n)
k('people.empty','Your customers will appear here.','आपके ग्राहक यहाँ दिखेंगे।','ನಿಮ್ಮ ಗ್ರಾಹಕರು ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತಾರೆ.')
k('people.line','{{visits}} visits · {{spend}} spent','{{visits}} बार आए · {{spend}} खर्च','{{visits}} ಭೇಟಿಗಳು · {{spend}} ಖರ್ಚು')
k('powers.sub','Services you connect so Orbit can work through them.','वे सेवाएँ जिन्हें जोड़कर Orbit उनके ज़रिए काम करता है।','Orbit ಅವುಗಳ ಮೂಲಕ ಕೆಲಸ ಮಾಡಲು ನೀವು ಜೋಡಿಸುವ ಸೇವೆಗಳು.')
k('powers.connected','Connected','जुड़ा हुआ','ಜೋಡಿಸಲಾಗಿದೆ')
k('powers.pending','Setting up','सेट हो रहा है','ಸೆಟಪ್ ಆಗುತ್ತಿದೆ')
k('powers.soon','Coming soon','जल्द आ रहा है','ಶೀಘ್ರದಲ್ಲೇ')
for g,(a,b,c) in {'messaging':('Messages and calls','संदेश और कॉल','ಸಂದೇಶ ಮತ್ತು ಕರೆಗಳು'),'calendar':('Calendar and meetings','कैलेंडर और मीटिंग','ಕ್ಯಾಲೆಂಡರ್ ಮತ್ತು ಸಭೆಗಳು'),'payments':('Payments','पेमेंट','ಪಾವತಿಗಳು'),'records':('Accounts and records','हिसाब और रिकॉर्ड','ಲೆಕ್ಕ ಮತ್ತು ದಾಖಲೆ'),'presence':('Online presence and ads','ऑनलाइन मौजूदगी और विज्ञापन','ಆನ್‌ಲೈನ್ ಉಪಸ್ಥಿತಿ ಮತ್ತು ಜಾಹೀರಾತು')}.items():
  k(f'powers.group.{g}',a,b,c)
P = {
 'whatsapp':('WhatsApp Business','Reply to customers and send reminders on WhatsApp.','WhatsApp पर ग्राहकों को जवाब और रिमाइंडर भेजें।','WhatsApp ನಲ್ಲಿ ಗ್ರಾಹಕರಿಗೆ ಉತ್ತರ ಮತ್ತು ಜ್ಞಾಪನೆ ಕಳುಹಿಸಿ.'),
 'instagram':('Instagram','Answer DMs and comments.','DM और कमेंट का जवाब दें।','DM ಮತ್ತು ಕಾಮೆಂಟ್‌ಗಳಿಗೆ ಉತ್ತರಿಸಿ.'),
 'messenger':('Facebook Messenger','Answer Facebook messages.','Facebook संदेशों का जवाब दें।','Facebook ಸಂದೇಶಗಳಿಗೆ ಉತ್ತರಿಸಿ.'),
 'gmail':('Gmail','Read enquiry emails and reply from your address.','पूछताछ के ईमेल पढ़ें और अपने पते से जवाब दें।','ವಿಚಾರಣೆ ಇಮೇಲ್ ಓದಿ ನಿಮ್ಮ ವಿಳಾಸದಿಂದ ಉತ್ತರಿಸಿ.'),
 'outlook':('Outlook','Read and reply to emails in Outlook.','Outlook में ईमेल पढ़ें और जवाब दें।','Outlook ನಲ್ಲಿ ಇಮೇಲ್ ಓದಿ ಉತ್ತರಿಸಿ.'),
 'sms':('SMS','Send reminders by text message.','SMS से रिमाइंडर भेजें।','SMS ಮೂಲಕ ಜ್ಞಾಪನೆ ಕಳುಹಿಸಿ.'),
 'phone':('Business phone number','Vox answers and makes calls.','Vox कॉल उठाएगा और करेगा।','Vox ಕರೆ ಸ್ವೀಕರಿಸಿ ಮಾಡುತ್ತದೆ.'),
 'telegram':('Telegram','Answer Telegram messages.','Telegram संदेशों का जवाब दें।','Telegram ಸಂದೇಶಗಳಿಗೆ ಉತ್ತರಿಸಿ.'),
 'google_calendar':('Google Calendar','Book only into free time and keep both calendars in step.','सिर्फ़ खाली समय में बुक करें और दोनों कैलेंडर मिलाकर रखें।','ಖಾಲಿ ಸಮಯದಲ್ಲಿ ಮಾತ್ರ ಬುಕ್ ಮಾಡಿ, ಎರಡೂ ಕ್ಯಾಲೆಂಡರ್ ಹೊಂದಿಸಿ.'),
 'outlook_calendar':('Outlook Calendar','Book only into free time.','सिर्फ़ खाली समय में बुक करें।','ಖಾಲಿ ಸಮಯದಲ್ಲಿ ಮಾತ್ರ ಬುಕ್ ಮಾಡಿ.'),
 'google_meet':('Google Meet','Add a video link to online appointments.','ऑनलाइन अपॉइंटमेंट में वीडियो लिंक जोड़ें।','ಆನ್‌ಲೈನ್ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗೆ ವೀಡಿಯೊ ಲಿಂಕ್ ಸೇರಿಸಿ.'),
 'zoom':('Zoom','Add a Zoom link to online appointments.','ऑनलाइन अपॉइंटमेंट में Zoom लिंक जोड़ें।','ಆನ್‌ಲೈನ್ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗೆ Zoom ಲಿಂಕ್ ಸೇರಿಸಿ.'),
 'razorpay':('Razorpay','Send UPI and card payment links.','UPI और कार्ड पेमेंट लिंक भेजें।','UPI ಮತ್ತು ಕಾರ್ಡ್ ಪಾವತಿ ಲಿಂಕ್ ಕಳುಹಿಸಿ.'),
 'cashfree':('Cashfree','Send payment links.','पेमेंट लिंक भेजें।','ಪಾವತಿ ಲಿಂಕ್ ಕಳುಹಿಸಿ.'),
 'phonepe':('PhonePe Business','Collect payments with PhonePe.','PhonePe से पेमेंट लें।','PhonePe ಮೂಲಕ ಪಾವತಿ ಸಂಗ್ರಹಿಸಿ.'),
 'paytm':('Paytm Business','Collect payments with Paytm.','Paytm से पेमेंट लें।','Paytm ಮೂಲಕ ಪಾವತಿ ಸಂಗ್ರಹಿಸಿ.'),
 'stripe':('Stripe','Collect card payments internationally.','अंतरराष्ट्रीय कार्ड पेमेंट लें।','ಅಂತರರಾಷ್ಟ್ರೀಯ ಕಾರ್ಡ್ ಪಾವತಿ ಸಂಗ್ರಹಿಸಿ.'),
 'tally':('Tally','Send your sales to Tally.','अपनी बिक्री Tally में भेजें।','ನಿಮ್ಮ ಮಾರಾಟವನ್ನು Tally ಗೆ ಕಳುಹಿಸಿ.'),
 'zoho_books':('Zoho Books','Keep your accounts in step.','अपना हिसाब मिलाकर रखें।','ನಿಮ್ಮ ಲೆಕ್ಕವನ್ನು ಹೊಂದಿಸಿ ಇಡಿ.'),
 'quickbooks':('QuickBooks','Keep your accounts in step.','अपना हिसाब मिलाकर रखें।','ನಿಮ್ಮ ಲೆಕ್ಕವನ್ನು ಹೊಂದಿಸಿ ಇಡಿ.'),
 'google_sheets':('Google Sheets','Keep customers, bookings and sales in a sheet.','ग्राहक, बुकिंग और बिक्री शीट में रखें।','ಗ್ರಾಹಕರು, ಬುಕಿಂಗ್ ಮತ್ತು ಮಾರಾಟವನ್ನು ಶೀಟ್‌ನಲ್ಲಿ ಇಡಿ.'),
 'google_drive':('Google Drive','Save invoices and price lists.','बिल और रेट लिस्ट सेव करें।','ಬಿಲ್ ಮತ್ತು ದರ ಪಟ್ಟಿ ಉಳಿಸಿ.'),
 'google_business_profile':('Google Business Profile','Update hours, post offers and reply to reviews.','समय अपडेट करें, ऑफ़र पोस्ट करें और रिव्यू का जवाब दें।','ಸಮಯ ನವೀಕರಿಸಿ, ಆಫರ್ ಪೋಸ್ಟ್ ಮಾಡಿ, ವಿಮರ್ಶೆಗಳಿಗೆ ಉತ್ತರಿಸಿ.'),
 'meta_ads':('Meta Ads','Bring ad leads straight into Orbit.','विज्ञापन लीड सीधे Orbit में लाएँ।','ಜಾಹೀರಾತು ಲೀಡ್‌ಗಳನ್ನು ನೇರವಾಗಿ Orbit ಗೆ ತನ್ನಿ.'),
 'google_ads':('Google Ads','Bring ad leads straight into Orbit.','विज्ञापन लीड सीधे Orbit में लाएँ।','ಜಾಹೀರಾತು ಲೀಡ್‌ಗಳನ್ನು ನೇರವಾಗಿ Orbit ಗೆ ತನ್ನಿ.'),
 'youtube':('YouTube','Share videos and posts.','वीडियो और पोस्ट शेयर करें।','ವೀಡಿಯೊ ಮತ್ತು ಪೋಸ್ಟ್ ಹಂಚಿಕೊಳ್ಳಿ.'),
 'linkedin':('LinkedIn Page','Share posts on your page.','अपने पेज पर पोस्ट शेयर करें।','ನಿಮ್ಮ ಪುಟದಲ್ಲಿ ಪೋಸ್ಟ್ ಹಂಚಿಕೊಳ್ಳಿ.'),
}
for p,(name,e,h,n) in P.items():
  k(f'power.{p}',name,name,name); k(f'power.{p}.what',e,h,n)
for c,(a,b,d) in {'whatsapp':('WhatsApp','WhatsApp','WhatsApp'),'instagram':('Instagram','Instagram','Instagram'),'website_chat':('website chat','वेबसाइट चैट','ವೆಬ್‌ಸೈಟ್ ಚಾಟ್'),'chat_link':('chat link','चैट लिंक','ಚಾಟ್ ಲಿಂಕ್'),'messenger':('Messenger','Messenger','Messenger'),'email':('email','ईमेल','ಇಮೇಲ್'),'gmail':('Gmail','Gmail','Gmail'),'sms':('SMS','SMS','SMS'),'phone':('phone','फ़ोन','ಫೋನ್'),'telegram':('Telegram','Telegram','Telegram')}.items():
  k(f'channel.{c}',a,b,d)
for c,(a,b,d) in {'open':('Open','खुली','ತೆರೆದಿದೆ'),'waiting_customer':('Waiting for customer','ग्राहक का इंतज़ार','ಗ್ರಾಹಕರಿಗಾಗಿ ಕಾಯುತ್ತಿದೆ'),'waiting_staff':('Waiting for you','आपका इंतज़ार','ನಿಮಗಾಗಿ ಕಾಯುತ್ತಿದೆ'),'closed':('Done','पूरी','ಮುಗಿದಿದೆ')}.items():
  k(f'conv.{c}',a,b,d)
k('details.bookings','Upcoming bookings','आने वाली बुकिंग','ಮುಂಬರುವ ಬುಕಿಂಗ್‌ಗಳು')
k('details.inbox','Conversations','बातचीत','ಸಂಭಾಷಣೆಗಳು')
k('details.no_bookings','No upcoming bookings yet.','अभी कोई आने वाली बुकिंग नहीं।','ಇನ್ನೂ ಮುಂಬರುವ ಬುಕಿಂಗ್ ಇಲ್ಲ.')
k('details.no_conversations','No conversations yet.','अभी कोई बातचीत नहीं।','ಇನ್ನೂ ಸಂಭಾಷಣೆಗಳಿಲ್ಲ.')
k('details.visitor','Visitor','विज़िटर','ಸಂದರ್ಶಕ')
k('details.more_soon','Calendar, payments, reports and settings arrive here next.','कैलेंडर, पेमेंट, रिपोर्ट और सेटिंग्स आगे यहाँ आएँगी।','ಕ್ಯಾಲೆಂಡರ್, ಪಾವತಿ, ವರದಿ ಮತ್ತು ಸೆಟ್ಟಿಂಗ್‌ಗಳು ಮುಂದೆ ಇಲ್ಲಿ ಬರುತ್ತವೆ.')

# public page + chat
k('public.open','Open now','अभी खुला है','ಈಗ ತೆರೆದಿದೆ')
k('public.closed','Closed now','अभी बंद है','ಈಗ ಮುಚ್ಚಿದೆ')
k('public.reviews','{{count}} reviews','{{count}} रिव्यू','{{count}} ವಿಮರ್ಶೆಗಳು')
k('public.reviews.one','1 review','1 रिव्यू','1 ವಿಮರ್ಶೆ')
k('public.services','Services and prices','सेवाएँ और कीमतें','ಸೇವೆಗಳು ಮತ್ತು ಬೆಲೆಗಳು')
k('public.minutes','{{count}} min','{{count}} मिनट','{{count}} ನಿಮಿಷ')
k('public.ask_price','Ask for price','कीमत पूछें','ಬೆಲೆ ಕೇಳಿ')
k('public.free','Free','मुफ़्त','ಉಚಿತ')
k('public.hours','Opening hours','खुलने का समय','ತೆರೆಯುವ ಸಮಯ')
k('public.what_people_say','What people say','लोग क्या कहते हैं','ಜನರು ಏನು ಹೇಳುತ್ತಾರೆ')
k('public.find_us','Find us','हमें ढूँढें','ನಮ್ಮನ್ನು ಹುಡುಕಿ')
k('public.open_map','Open in Maps','मैप में खोलें','ನಕ್ಷೆಯಲ್ಲಿ ತೆರೆಯಿರಿ')
k('public.powered','Powered by Orbit','Orbit द्वारा संचालित','Orbit ನಿಂದ ಚಾಲಿತ')
k('public.book_chat','Book or ask a question','बुक करें या सवाल पूछें','ಬುಕ್ ಮಾಡಿ ಅಥವಾ ಪ್ರಶ್ನೆ ಕೇಳಿ')
k('public.call','Call','कॉल करें','ಕರೆ ಮಾಡಿ')
k('chat.title','Chat with {{business}}','{{business}} से चैट करें','{{business}} ಜೊತೆ ಚಾಟ್ ಮಾಡಿ')
k('chat.greeting','Hi! I am Aria from {{business}}. How can I help you today?','नमस्ते! मैं {{business}} से Aria हूँ। आज मैं आपकी क्या मदद कर सकती हूँ?','ನಮಸ್ಕಾರ! ನಾನು {{business}} ನ Aria. ಇಂದು ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?')
k('chat.chip.book','Book','बुक करें','ಬುಕ್ ಮಾಡಿ')
k('chat.chip.prices','Prices','कीमतें','ಬೆಲೆಗಳು')
k('chat.chip.timings','Timings','समय','ಸಮಯ')
k('chat.chip.human','Talk to a person','किसी इंसान से बात करें','ವ್ಯಕ್ತಿಯೊಂದಿಗೆ ಮಾತನಾಡಿ')
k('chat.soon','Aria is getting ready to chat here. For now, please call or WhatsApp us using the buttons below.','Aria यहाँ चैट के लिए तैयार हो रही है। अभी के लिए नीचे के बटन से कॉल या WhatsApp करें।','Aria ಇಲ್ಲಿ ಚಾಟ್ ಮಾಡಲು ಸಿದ್ಧಳಾಗುತ್ತಿದ್ದಾಳೆ. ಸದ್ಯಕ್ಕೆ ಕೆಳಗಿನ ಬಟನ್ ಬಳಸಿ ಕರೆ ಅಥವಾ WhatsApp ಮಾಡಿ.')


# ---------- Phase 2: chat, Aria, Nudge, bookings, briefings ----------
k('chat.greeting_named','Hi! I am {{agent}} from {{business}}. How can I help you today?','नमस्ते! मैं {{business}} से {{agent}} हूँ। आज मैं आपकी क्या मदद कर सकती हूँ?','ನಮಸ್ಕಾರ! ನಾನು {{business}} ನ {{agent}}. ಇಂದು ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?')
k('aria.auto.handover','Of course. A person from {{business}} will reply here soon.','ज़रूर। {{business}} से कोई व्यक्ति जल्द ही यहाँ जवाब देगा।','ಖಂಡಿತ. {{business}} ನಿಂದ ಒಬ್ಬರು ಶೀಘ್ರದಲ್ಲೇ ಇಲ್ಲಿ ಉತ್ತರಿಸುತ್ತಾರೆ.')
k('aria.auto.team_will_reply','Thanks for your message! The team at {{business}} will reply here soon.','आपके संदेश के लिए धन्यवाद! {{business}} की टीम जल्द ही यहाँ जवाब देगी।','ನಿಮ್ಮ ಸಂದೇಶಕ್ಕೆ ಧನ್ಯವಾದ! {{business}} ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ಇಲ್ಲಿ ಉತ್ತರಿಸುತ್ತದೆ.')
k('aria.auto.trouble','Sorry, I am having a little trouble right now. The team will reply here shortly.','माफ़ कीजिए, अभी थोड़ी दिक्कत है। टीम जल्द ही यहाँ जवाब देगी।','ಕ್ಷಮಿಸಿ, ಈಗ ಸ್ವಲ್ಪ ತೊಂದರೆ ಇದೆ. ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ಇಲ್ಲಿ ಉತ್ತರಿಸುತ್ತದೆ.')
k('aria.auto.check_price','Let me confirm the exact price with the team. They will reply here shortly.','सही कीमत मैं टीम से पक्का कर लेती हूँ। वे जल्द ही यहाँ जवाब देंगे।','ನಿಖರ ಬೆಲೆಯನ್ನು ತಂಡದೊಂದಿಗೆ ಖಚಿತಪಡಿಸುತ್ತೇನೆ. ಅವರು ಶೀಘ್ರದಲ್ಲೇ ಇಲ್ಲಿ ಉತ್ತರಿಸುತ್ತಾರೆ.')
k('feed.orbit.booked','{{customer}} was booked for {{service}} at {{time}}','{{customer}} की {{service}} {{time}} बजे बुक हुई','{{customer}} ಅವರಿಗೆ {{time}} ಕ್ಕೆ {{service}} ಬುಕ್ ಆಗಿದೆ')
k('feed.orbit.booking_moved','{{customer}}\'s booking moved to {{time}}','{{customer}} की बुकिंग {{time}} पर बदली गई','{{customer}} ಅವರ ಬುಕಿಂಗ್ {{time}} ಕ್ಕೆ ಬದಲಾಗಿದೆ')
k('feed.orbit.booking_cancelled','{{customer}} cancelled the {{time}} booking','{{customer}} ने {{time}} की बुकिंग रद्द की','{{customer}} {{time}} ರ ಬುಕಿಂಗ್ ರದ್ದುಗೊಳಿಸಿದರು')
k('feed.orbit.handover_expired','Nobody replied to a customer in time, so Aria picked the chat back up.','किसी ने समय पर ग्राहक को जवाब नहीं दिया, इसलिए Aria ने चैट फिर से संभाल ली।','ಯಾರೂ ಸಮಯಕ್ಕೆ ಗ್ರಾಹಕರಿಗೆ ಉತ್ತರಿಸಲಿಲ್ಲ, ಹಾಗಾಗಿ Aria ಚಾಟ್ ಮತ್ತೆ ವಹಿಸಿಕೊಂಡಳು.')
k('feed.orbit.morning_briefing','Your morning briefing is ready','आपकी सुबह की ब्रीफ़िंग तैयार है','ನಿಮ್ಮ ಬೆಳಗಿನ ಬ್ರೀಫಿಂಗ್ ಸಿದ್ಧವಾಗಿದೆ')
k('feed.orbit.evening_summary','Your evening summary is ready','आपका शाम का सारांश तैयार है','ನಿಮ್ಮ ಸಂಜೆಯ ಸಾರಾಂಶ ಸಿದ್ಧವಾಗಿದೆ')
k('feed.nudge.reminder_sent','{{agent}} reminded {{customer}} about their {{service}}','{{agent}} ने {{customer}} को उनकी {{service}} की याद दिलाई','{{agent}} {{customer}} ಅವರಿಗೆ ಅವರ {{service}} ಬಗ್ಗೆ ನೆನಪಿಸಿದೆ')
k('feed.nudge.follow_up_sent','{{agent}} followed up with {{customer}}','{{agent}} ने {{customer}} से फ़ॉलो-अप किया','{{agent}} {{customer}} ಅವರನ್ನು ಫಾಲೋ-ಅಪ್ ಮಾಡಿದೆ')
k('feed.group.follow_up_sent','{{agent}} followed up with {{count}} people','{{agent}} ने {{count}} लोगों से फ़ॉलो-अप किया','{{agent}} {{count}} ಜನರನ್ನು ಫಾಲೋ-ಅಪ್ ಮಾಡಿದೆ')
k('card.handover','{{customer}} needs a person: {{reason}}','{{customer}} को किसी इंसान की ज़रूरत है: {{reason}}','{{customer}} ಅವರಿಗೆ ಒಬ್ಬ ವ್ಯಕ್ತಿ ಬೇಕು: {{reason}}')
k('card.handover_visitor','A website visitor needs a person: {{reason}}','एक वेबसाइट विज़िटर को किसी इंसान की ज़रूरत है: {{reason}}','ವೆಬ್‌ಸೈಟ್ ಸಂದರ್ಶಕರಿಗೆ ಒಬ್ಬ ವ್ಯಕ್ತಿ ಬೇಕು: {{reason}}')
k('card.option.let_aria','Let Aria handle it','Aria को संभालने दें','Aria ನೋಡಿಕೊಳ್ಳಲಿ')
k('notify.handover','{{customer}} wants to talk to a person','{{customer}} किसी इंसान से बात करना चाहते हैं','{{customer}} ವ್ಯಕ್ತಿಯೊಂದಿಗೆ ಮಾತನಾಡಲು ಬಯಸುತ್ತಾರೆ')
k('notify.morning_briefing','Good morning! Your briefing is ready.','सुप्रभात! आपकी ब्रीफ़िंग तैयार है।','ಶುಭೋದಯ! ನಿಮ್ಮ ಬ್ರೀಫಿಂಗ್ ಸಿದ್ಧವಾಗಿದೆ.')
k('notify.evening_summary','Your day is done. See the summary.','आपका दिन पूरा हुआ। सारांश देखें।','ನಿಮ್ಮ ದಿನ ಮುಗಿಯಿತು. ಸಾರಾಂಶ ನೋಡಿ.')
k('activity.aria.replying','{{agent}} is replying to {{customer}} on {{channel}}','{{agent}} {{channel}} पर {{customer}} को जवाब दे रही है','{{agent}} {{channel}} ನಲ್ಲಿ {{customer}} ಅವರಿಗೆ ಉತ್ತರಿಸುತ್ತಿದೆ')
k('activity.aria.replying_visitor','{{agent}} is chatting with a visitor on {{channel}}','{{agent}} {{channel}} पर एक विज़िटर से चैट कर रही है','{{agent}} {{channel}} ನಲ್ಲಿ ಸಂದರ್ಶಕರೊಂದಿಗೆ ಚಾಟ್ ಮಾಡುತ್ತಿದೆ')
k('activity.nudge.sending','{{agent}} is sending reminders','{{agent}} रिमाइंडर भेज रहा है','{{agent}} ಜ್ಞಾಪನೆಗಳನ್ನು ಕಳುಹಿಸುತ್ತಿದೆ')
k('suggest.who_unpaid_week','Who hasn\'t paid this week?','इस हफ़्ते किसने पेमेंट नहीं किया?','ಈ ವಾರ ಯಾರು ಪಾವತಿಸಿಲ್ಲ?')
k('suggest.call_tomorrow','Call everyone booked tomorrow','कल बुक हुए सभी को कॉल करो','ನಾಳೆ ಬುಕ್ ಆದ ಎಲ್ಲರಿಗೂ ಕರೆ ಮಾಡಿ')
k('suggest.fill_slots','Fill my empty slots this week','इस हफ़्ते के खाली स्लॉट भरो','ಈ ವಾರದ ಖಾಲಿ ಸ್ಲಾಟ್‌ಗಳನ್ನು ತುಂಬಿ')


# ---------- Phase 2: The Bridge redesign, inbox, booking, manage, Powers ----------
k('greet.morning','Good morning, {{name}}','सुप्रभात, {{name}}','ಶುಭೋದಯ, {{name}}')
k('greet.afternoon','Good afternoon, {{name}}','नमस्ते, {{name}}','ಶುಭ ಮಧ್ಯಾಹ್ನ, {{name}}')
k('greet.evening','Good evening, {{name}}','शुभ संध्या, {{name}}','ಶುಭ ಸಂಜೆ, {{name}}')
k('hero.working','Your Crew is working','आपका Crew काम पर है','ನಿಮ್ಮ Crew ಕೆಲಸದಲ್ಲಿದೆ')
k('hero.live','Live','लाइव','ಲೈವ್')
k('hero.orbit_label','Your Crew around your Business Pulse','आपके बिज़नेस पल्स के चारों ओर आपका Crew','ನಿಮ್ಮ ವ್ಯಾಪಾರ ಪಲ್ಸ್ ಸುತ್ತ ನಿಮ್ಮ Crew')
k('hero.agent_label','{{agent}}: {{status}}. Open in Crew.','{{agent}}: {{status}}। Crew में खोलें।','{{agent}}: {{status}}. Crew ನಲ್ಲಿ ತೆರೆಯಿರಿ.')
k('hero.ready','Your Crew is ready. Share your booking link to get started.','आपका Crew तैयार है। शुरू करने के लिए अपना बुकिंग लिंक शेयर करें।','ನಿಮ್ಮ Crew ಸಿದ್ಧವಾಗಿದೆ. ಪ್ರಾರಂಭಿಸಲು ನಿಮ್ಮ ಬುಕಿಂಗ್ ಲಿಂಕ್ ಹಂಚಿಕೊಳ್ಳಿ.')
k('hero.share','Share','शेयर करें','ಹಂಚಿಕೊಳ್ಳಿ')
k('crew.status.working','Working','काम कर रहा है','ಕೆಲಸ ಮಾಡುತ್ತಿದೆ')
k('crew.status.idle','Ready','तैयार','ಸಿದ್ಧ')
k('crew.status.off','Off','बंद','ಆಫ್')
k('crew.nothing_yet','Nothing yet today.','आज अभी तक कुछ नहीं।','ಇಂದು ಇನ್ನೂ ಏನೂ ಇಲ್ಲ.')
k('tiles.money_today','money today','आज की कमाई','ಇಂದಿನ ಹಣ')
k('tiles.bookings_today','bookings today','आज की बुकिंग','ಇಂದಿನ ಬುಕಿಂಗ್')
k('tiles.need_you','need you','आपकी ज़रूरत','ನಿಮ್ಮ ಅಗತ್ಯ')
k('needs.decisions','{{count}} decisions','{{count}} फ़ैसले','{{count}} ನಿರ್ಧಾರಗಳು')
k('needs.decisions.one','1 decision','1 फ़ैसला','1 ನಿರ್ಧಾರ')
k('needs.all_clear','all clear','सब ठीक','ಎಲ್ಲವೂ ಸರಿ')
k('needs.nothing','Nothing needs you','अभी आपकी ज़रूरत नहीं','ಈಗ ನಿಮ್ಮ ಅಗತ್ಯವಿಲ್ಲ')
k('needs.handled','Orbit has everything handled. Enjoy your {{day}}.','Orbit सब संभाल रहा है। अपने {{day}} का आनंद लें।','Orbit ಎಲ್ಲವನ್ನೂ ನೋಡಿಕೊಳ್ಳುತ್ತಿದೆ. ನಿಮ್ಮ {{day}} ಆನಂದಿಸಿ.')
k('needs.later','Later','बाद में','ನಂತರ')
k('needs.suggest.handover','Tap to answer them yourself, or let Aria carry on.','खुद जवाब देने के लिए टैप करें, या Aria को जारी रखने दें।','ನೀವೇ ಉತ್ತರಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ, ಅಥವಾ Aria ಮುಂದುವರಿಸಲಿ.')
k('needs.suggest.review','Orbit wrote a calm, polite reply you can post as it is.','Orbit ने एक शांत, विनम्र जवाब लिखा है जिसे आप वैसे ही पोस्ट कर सकते हैं।','Orbit ಶಾಂತ, ವಿನಯದ ಉತ್ತರ ಬರೆದಿದೆ, ನೀವು ಹಾಗೆಯೇ ಪೋಸ್ಟ್ ಮಾಡಬಹುದು.')
k('needs.suggest.discount','Orbit suggests a small one-time discount to win the booking.','Orbit बुकिंग पाने के लिए एक छोटी, एक बार की छूट का सुझाव देता है।','ಬುಕಿಂಗ್ ಪಡೆಯಲು Orbit ಒಂದು ಸಣ್ಣ, ಒಮ್ಮೆಯ ರಿಯಾಯಿತಿ ಸೂಚಿಸುತ್ತದೆ.')
k('zone.crew_did','What your Crew did','आपके Crew ने क्या किया','ನಿಮ್ಮ Crew ಏನು ಮಾಡಿತು')
k('earn.title','Orbit earned you this month','इस महीने Orbit ने आपको कमाकर दिया','ಈ ತಿಂಗಳು Orbit ನಿಮಗೆ ಗಳಿಸಿದ್ದು')
k('earn.hours','{{count}} hrs','{{count}} घंटे','{{count}} ಗಂಟೆ')
k('earn.hours.one','1 hr','1 घंटा','1 ಗಂಟೆ')
k('earn.saved','saved','बचाए','ಉಳಿತಾಯ')
k('time.just_now','just now','अभी','ಈಗಷ್ಟೇ')
k('time.min_ago','{{count}} min ago','{{count}} मिनट पहले','{{count}} ನಿಮಿಷ ಹಿಂದೆ')
k('time.hr_ago','{{count}} hr ago','{{count}} घंटे पहले','{{count}} ಗಂಟೆ ಹಿಂದೆ')
k('time.day_ago','{{count}} days ago','{{count}} दिन पहले','{{count}} ದಿನ ಹಿಂದೆ')
k('time.day_ago.one','yesterday','कल','ನಿನ್ನೆ')
k('brief.title_morning','Your morning briefing','आपकी सुबह की ब्रीफ़िंग','ನಿಮ್ಮ ಬೆಳಗಿನ ಬ್ರೀಫಿಂಗ್')
k('brief.title_evening','Your day so far','आज का दिन अब तक','ಇಂದಿನ ದಿನ ಇಲ್ಲಿಯವರೆಗೆ')
k('cmd.try','Try: “{{example}}”','आज़माएँ: “{{example}}”','ಪ್ರಯತ್ನಿಸಿ: “{{example}}”')
k('cmd.no_voice','Voice is not available in this browser','इस ब्राउज़र में आवाज़ उपलब्ध नहीं है','ಈ ಬ್ರೌಸರ್‌ನಲ್ಲಿ ಧ್ವನಿ ಲಭ್ಯವಿಲ್ಲ')
k('common.retry','Try again','फिर से कोशिश करें','ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ')
k('bridge.error','We could not load your Bridge just now.','हम अभी आपका Bridge लोड नहीं कर पाए।','ಈಗ ನಿಮ್ಮ Bridge ಲೋಡ್ ಮಾಡಲು ಆಗಲಿಲ್ಲ.')
k('bridge.offline','You seem to be offline. We will catch up when you are back.','लगता है आप ऑफ़लाइन हैं। वापस आने पर सब अपडेट हो जाएगा।','ನೀವು ಆಫ್‌ಲೈನ್ ಇದ್ದಂತಿದೆ. ಮರಳಿ ಬಂದಾಗ ಎಲ್ಲವೂ ನವೀಕರಿಸುತ್ತದೆ.')
k('bridge.notifications','Notifications, {{count}} unread','सूचनाएँ, {{count}} अपठित','ಅಧಿಸೂಚನೆಗಳು, {{count}} ಓದದವು')
k('bridge.notifications_title','Notifications','सूचनाएँ','ಅಧಿಸೂಚನೆಗಳು')
k('bridge.no_notifications','Nothing new.','कुछ नया नहीं।','ಹೊಸದೇನೂ ಇಲ್ಲ.')
k('view.today','Today','आज','ಇಂದು')
for st,(a,b,c) in {'queued':('waiting to start','शुरू होने वाला','ಪ್ರಾರಂಭಕ್ಕೆ ಕಾಯುತ್ತಿದೆ'),'running':('in progress','चल रहा है','ನಡೆಯುತ್ತಿದೆ'),'waiting_approval':('waiting for you','आपका इंतज़ार','ನಿಮಗಾಗಿ ಕಾಯುತ್ತಿದೆ'),'waiting_customer':('waiting for the customer','ग्राहक का इंतज़ार','ಗ್ರಾಹಕರಿಗಾಗಿ ಕಾಯುತ್ತಿದೆ'),'done':('done','पूरा','ಮುಗಿದಿದೆ'),'failed':('could not finish','पूरा नहीं हो सका','ಮುಗಿಸಲಾಗಲಿಲ್ಲ'),'cancelled':('cancelled','रद्द','ರದ್ದಾಗಿದೆ')}.items():
  k(f'task.{st}',a,b,c)
k('inbox.title','Inbox','इनबॉक्स','ಇನ್‌ಬಾಕ್ಸ್')
k('inbox.open','Open inbox','इनबॉक्स खोलें','ಇನ್‌ಬಾಕ್ಸ್ ತೆರೆಯಿರಿ')
k('inbox.filters','Show','दिखाएँ','ತೋರಿಸು')
for f,(a,b,c) in {'all':('All','सभी','ಎಲ್ಲಾ'),'needs_me':('Need me','मेरी ज़रूरत','ನನ್ನ ಅಗತ್ಯ'),'aria':('Aria handling','Aria संभाल रही है','Aria ನೋಡಿಕೊಳ್ಳುತ್ತಿದೆ'),'human':('Team handling','टीम संभाल रही है','ತಂಡ ನೋಡಿಕೊಳ್ಳುತ್ತಿದೆ'),'closed':('Done','पूरी','ಮುಗಿದವು')}.items():
  k(f'inbox.filter.{f}',a,b,c)
k('inbox.empty','No conversations here yet.','यहाँ अभी कोई बातचीत नहीं।','ಇಲ್ಲಿ ಇನ್ನೂ ಸಂಭಾಷಣೆಗಳಿಲ್ಲ.')
k('inbox.you','You','आप','ನೀವು')
k('inbox.team','Team','टीम','ತಂಡ')
k('inbox.aria_handling','Aria is replying','Aria जवाब दे रही है','Aria ಉತ್ತರಿಸುತ್ತಿದೆ')
k('inbox.you_handling','You are replying','आप जवाब दे रहे हैं','ನೀವು ಉತ್ತರಿಸುತ್ತಿದ್ದೀರಿ')
k('inbox.team_handling','Waiting for the team','टीम का इंतज़ार','ತಂಡಕ್ಕಾಗಿ ಕಾಯುತ್ತಿದೆ')
k('inbox.take_over','Take over','खुद संभालें','ನಾನೇ ನೋಡಿಕೊಳ್ಳುತ್ತೇನೆ')
k('inbox.hand_back','Hand back to Aria','Aria को वापस दें','Aria ಗೆ ಮರಳಿ ಕೊಡಿ')
k('inbox.reply','Write a reply','जवाब लिखें','ಉತ್ತರ ಬರೆಯಿರಿ')
k('inbox.reply_takes_over','Reply (you will take over from Aria)','जवाब दें (आप Aria से संभाल लेंगे)','ಉತ್ತರಿಸಿ (ನೀವು Aria ಯಿಂದ ವಹಿಸಿಕೊಳ್ಳುತ್ತೀರಿ)')
k('public.book','Book now','अभी बुक करें','ಈಗ ಬುಕ್ ಮಾಡಿ')
k('public.chat','Chat','चैट','ಚಾಟ್')
k('book.pick_service','What would you like to book?','आप क्या बुक करना चाहेंगे?','ನೀವು ಏನು ಬುಕ್ ಮಾಡಲು ಬಯಸುತ್ತೀರಿ?')
k('book.pick_person','Who would you like?','आप किसके साथ चाहेंगे?','ಯಾರ ಜೊತೆ ಬೇಕು?')
k('book.any','Anyone available','जो भी खाली हो','ಯಾರಾದರೂ ಲಭ್ಯವಿರುವವರು')
k('book.pick_time','Pick a time','समय चुनें','ಸಮಯ ಆಯ್ಕೆಮಾಡಿ')
k('book.no_slots','No free times in the next 7 days. Please chat with us or call.','अगले 7 दिनों में कोई खाली समय नहीं। कृपया चैट करें या कॉल करें।','ಮುಂದಿನ 7 ದಿನಗಳಲ್ಲಿ ಖಾಲಿ ಸಮಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ಚಾಟ್ ಅಥವಾ ಕರೆ ಮಾಡಿ.')
k('book.name','Your name','आपका नाम','ನಿಮ್ಮ ಹೆಸರು')
k('book.phone','Mobile number','मोबाइल नंबर','ಮೊಬೈಲ್ ಸಂಖ್ಯೆ')
k('book.confirm','Confirm booking','बुकिंग पक्की करें','ಬುಕಿಂಗ್ ಖಚಿತಪಡಿಸಿ')
k('book.change_time','Change time','समय बदलें','ಸಮಯ ಬದಲಿಸಿ')
k('book.done_title','You are booked!','आपकी बुकिंग हो गई!','ನಿಮ್ಮ ಬುಕಿಂಗ್ ಆಗಿದೆ!')
k('book.done','{{service}} on {{when}}. We will remind you before.','{{when}} को {{service}}। हम पहले याद दिला देंगे।','{{when}} ರಂದು {{service}}. ಮೊದಲೇ ನೆನಪಿಸುತ್ತೇವೆ.')
k('book.add_calendar','Add to my calendar','मेरे कैलेंडर में जोड़ें','ನನ್ನ ಕ್ಯಾಲೆಂಡರ್‌ಗೆ ಸೇರಿಸಿ')
k('book.manage','Change or cancel','बदलें या रद्द करें','ಬದಲಿಸಿ ಅಥವಾ ರದ್ದುಮಾಡಿ')
k('chat.placeholder','Type your message','अपना संदेश लिखें','ನಿಮ್ಮ ಸಂದೇಶ ಟೈಪ್ ಮಾಡಿ')
k('chat.error','Something went wrong. Please try again.','कुछ गड़बड़ हुई। कृपया फिर कोशिश करें।','ಏನೋ ತಪ್ಪಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.')
k('chat.human_joined','A person from the team is now chatting with you.','टीम का एक सदस्य अब आपसे चैट कर रहा है।','ತಂಡದ ಒಬ್ಬರು ಈಗ ನಿಮ್ಮೊಂದಿಗೆ ಚಾಟ್ ಮಾಡುತ್ತಿದ್ದಾರೆ.')
k('chat.team','{{business}} team','{{business}} टीम','{{business}} ತಂಡ')
for c,(a,b,d) in {'book':('I would like to book an appointment','मुझे अपॉइंटमेंट बुक करना है','ನನಗೆ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಬೇಕು'),'prices':('What are your prices?','आपकी कीमतें क्या हैं?','ನಿಮ್ಮ ಬೆಲೆಗಳು ಏನು?'),'timings':('What are your timings?','आपका समय क्या है?','ನಿಮ್ಮ ಸಮಯ ಏನು?'),'human':('I want to talk to a person','मुझे किसी इंसान से बात करनी है','ನಾನು ವ್ಯಕ್ತಿಯೊಂದಿಗೆ ಮಾತನಾಡಬೇಕು')}.items():
  k(f'chat.say.{c}',a,b,d)
k('manage.with','with {{name}}','{{name}} के साथ','{{name}} ಜೊತೆ')
for st,(a,b,c) in {'pending':('Waiting for confirmation','पुष्टि का इंतज़ार','ದೃಢೀಕರಣಕ್ಕಾಗಿ ಕಾಯುತ್ತಿದೆ'),'confirmed':('Confirmed','पक्की','ದೃಢಪಡಿಸಲಾಗಿದೆ'),'completed':('Completed','पूरी हुई','ಮುಗಿದಿದೆ'),'cancelled':('Cancelled','रद्द','ರದ್ದಾಗಿದೆ'),'no_show':('Missed','छूट गई','ತಪ್ಪಿಹೋಯಿತು')}.items():
  k(f'manage.status.{st}',a,b,c)
k('manage.reschedule','Move to another time','दूसरे समय पर बदलें','ಬೇರೆ ಸಮಯಕ್ಕೆ ಬದಲಿಸಿ')
k('manage.cancel','Cancel booking','बुकिंग रद्द करें','ಬುಕಿಂಗ್ ರದ್ದುಮಾಡಿ')
k('manage.confirm_cancel','Cancel this booking?','यह बुकिंग रद्द करें?','ಈ ಬುಕಿಂಗ್ ರದ್ದುಮಾಡಬೇಕೇ?')
k('manage.cancelled','Your booking is cancelled.','आपकी बुकिंग रद्द हो गई।','ನಿಮ್ಮ ಬುಕಿಂಗ್ ರದ್ದಾಗಿದೆ.')
k('manage.moved','Done! Your booking has moved.','हो गया! आपकी बुकिंग बदल गई।','ಆಯಿತು! ನಿಮ್ಮ ಬುಕಿಂಗ್ ಬದಲಾಗಿದೆ.')
k('manage.too_late','Changes are possible up to {{hours}} hours before. Please call the business.','बदलाव {{hours}} घंटे पहले तक हो सकते हैं। कृपया बिज़नेस को कॉल करें।','{{hours}} ಗಂಟೆ ಮೊದಲು ತನಕ ಬದಲಾವಣೆ ಸಾಧ್ಯ. ದಯವಿಟ್ಟು ಕರೆ ಮಾಡಿ.')
k('manage.back','Back to {{business}}','{{business}} पर वापस','{{business}} ಗೆ ಹಿಂತಿರುಗಿ')
k('knowledge.title','What Orbit knows','Orbit क्या जानता है','Orbit ಗೆ ಏನು ಗೊತ್ತು')
k('knowledge.sub','Aria answers only from this. Add anything customers often ask.','Aria सिर्फ़ इसी से जवाब देती है। ग्राहक जो अक्सर पूछते हैं, वह जोड़ें।','Aria ಇದರಿಂದ ಮಾತ್ರ ಉತ್ತರಿಸುತ್ತಾಳೆ. ಗ್ರಾಹಕರು ಹೆಚ್ಚಾಗಿ ಕೇಳುವುದನ್ನು ಸೇರಿಸಿ.')
k('knowledge.question','Question, e.g. Do you have parking?','सवाल, जैसे क्या पार्किंग है?','ಪ್ರಶ್ನೆ, ಉದಾ. ಪಾರ್ಕಿಂಗ್ ಇದೆಯೇ?')
k('knowledge.answer','Answer','जवाब','ಉತ್ತರ')
k('knowledge.add','Add','जोड़ें','ಸೇರಿಸಿ')
k('powers.connect','Connect','जोड़ें','ಜೋಡಿಸಿ')
k('powers.disconnect','Disconnect','हटाएँ','ಸಂಪರ್ಕ ತೆಗೆಯಿರಿ')
k('powers.reconnect','Reconnect','फिर से जोड़ें','ಮತ್ತೆ ಜೋಡಿಸಿ')
k('powers.reconnect_needed','Access expired. Tap reconnect.','एक्सेस खत्म हो गया। फिर से जोड़ें दबाएँ।','ಪ್ರವೇಶ ಅವಧಿ ಮುಗಿದಿದೆ. ಮತ್ತೆ ಜೋಡಿಸಿ ಒತ್ತಿ.')
k('powers.upgrade','Upgrade','अपग्रेड','ಅಪ್‌ಗ್ರೇಡ್')
k('powers.confirm_disconnect','Disconnect {{power}}? Orbit will stop using it straight away.','{{power}} हटाएँ? Orbit तुरंत इसका इस्तेमाल बंद कर देगा।','{{power}} ಸಂಪರ್ಕ ತೆಗೆಯಬೇಕೇ? Orbit ತಕ್ಷಣ ಬಳಸುವುದನ್ನು ನಿಲ್ಲಿಸುತ್ತದೆ.')
for r,(a,b,c) in {'connected':('{{power}} is connected.','{{power}} जुड़ गया।','{{power}} ಜೋಡಣೆಯಾಗಿದೆ.'),'expired':('That link expired. Please try connecting again.','वह लिंक खत्म हो गया। कृपया फिर से जोड़ें।','ಆ ಲಿಂಕ್ ಅವಧಿ ಮುಗಿದಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಜೋಡಿಸಿ.'),'declined':('Connection was cancelled. Nothing was changed.','जोड़ना रद्द किया गया। कुछ नहीं बदला।','ಜೋಡಣೆ ರದ್ದಾಯಿತು. ಏನೂ ಬದಲಾಗಿಲ್ಲ.'),'permissions':('Orbit needs every permission shown to use {{power}}. Please try again and allow them all.','{{power}} के लिए Orbit को दिखाई गई सभी अनुमतियाँ चाहिए। कृपया फिर से कोशिश करें।','{{power}} ಬಳಸಲು Orbit ಗೆ ತೋರಿಸಿದ ಎಲ್ಲಾ ಅನುಮತಿಗಳು ಬೇಕು. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.'),'failed':('Something went wrong while connecting. Please try again.','जोड़ते समय कुछ गड़बड़ हुई। कृपया फिर कोशिश करें।','ಜೋಡಿಸುವಾಗ ಏನೋ ತಪ್ಪಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.')}.items():
  k(f'powers.result.{r}',a,b,c)
k('feed.orbit.power_connected','{{power}} is connected','{{power}} जुड़ गया','{{power}} ಜೋಡಣೆಯಾಗಿದೆ')
k('feed.orbit.power_disconnected','{{power}} was disconnected','{{power}} हटा दिया गया','{{power}} ಸಂಪರ್ಕ ತೆಗೆಯಲಾಗಿದೆ')
k('notify.power_broken','{{power}} needs reconnecting','{{power}} को फिर से जोड़ना होगा','{{power}} ಅನ್ನು ಮತ್ತೆ ಜೋಡಿಸಬೇಕು')
for c,(a,b,d) in {'booking_page':('booking page','बुकिंग पेज','ಬುಕಿಂಗ್ ಪುಟ'),'owner':('you','आप','ನೀವು'),'web_chat':('website chat','वेबसाइट चैट','ವೆಬ್‌ಸೈಟ್ ಚಾಟ್'),'dev':('test','टेस्ट','ಪರೀಕ್ಷೆ')}.items():
  k(f'channel.{c}',a,b,d)


k('activity.vox.calling','{{agent}} is calling {{count}} members about renewals','{{agent}} रिन्यूअल के लिए {{count}} मेंबर्स को कॉल कर रहा है','{{agent}} ನವೀಕರಣಕ್ಕಾಗಿ {{count}} ಸದಸ್ಯರಿಗೆ ಕರೆ ಮಾಡುತ್ತಿದೆ')
k('channel.google_business_profile','Google reviews','Google रिव्यू','Google ವಿಮರ್ಶೆಗಳು')


# ---------- Supabase sign-in ----------
k('login.google','Continue with Google','Google से जारी रखें','Google ಮೂಲಕ ಮುಂದುವರಿಯಿರಿ')
k('login.google_failed','Google sign-in is not available right now. Please use your email.','Google साइन-इन अभी उपलब्ध नहीं है। कृपया अपना ईमेल इस्तेमाल करें।','Google ಸೈನ್-ಇನ್ ಈಗ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಇಮೇಲ್ ಬಳಸಿ.')
k('login.wait_minute','Please wait a minute before asking for another code.','दूसरा कोड माँगने से पहले कृपया एक मिनट रुकें।','ಇನ್ನೊಂದು ಕೋಡ್ ಕೇಳುವ ಮೊದಲು ದಯವಿಟ್ಟು ಒಂದು ನಿಮಿಷ ಕಾಯಿರಿ.')
k('login.code_failed','We could not send a code to that number. Please check it and try again.','हम उस नंबर पर कोड नहीं भेज पाए। कृपया नंबर जाँचकर फिर कोशिश करें।','ಆ ಸಂಖ್ಯೆಗೆ ಕೋಡ್ ಕಳುಹಿಸಲು ಆಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.')
k('login.code_wrong','That code is not right or has expired. Please try again.','यह कोड सही नहीं है या समाप्त हो गया है। कृपया फिर कोशिश करें।','ಈ ಕೋಡ್ ಸರಿಯಿಲ್ಲ ಅಥವಾ ಅವಧಿ ಮುಗಿದಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.')


# ---------- Email sign-in ----------
k('login.welcome','Welcome to Orbit','Orbit में आपका स्वागत है','Orbit ಗೆ ಸ್ವಾಗತ')
k('login.tagline','Sign in with your email. Your Crew is waiting.','अपने ईमेल से साइन इन करें। आपका Crew इंतज़ार कर रहा है।','ನಿಮ್ಮ ಇಮೇಲ್ ಮೂಲಕ ಸೈನ್ ಇನ್ ಮಾಡಿ. ನಿಮ್ಮ Crew ಕಾಯುತ್ತಿದೆ.')
k('login.email','Email address','ईमेल पता','ಇಮೇಲ್ ವಿಳಾಸ')
k('login.email_invalid','That email address does not look right. Please check it.','यह ईमेल पता सही नहीं लगता। कृपया जाँचें।','ಈ ಇಮೇಲ್ ವಿಳಾಸ ಸರಿಯಿಲ್ಲದಂತಿದೆ. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ.')
k('login.email_failed','We could not send a code to that email. Please check it and try again.','हम उस ईमेल पर कोड नहीं भेज पाए। कृपया जाँचकर फिर कोशिश करें।','ಆ ಇಮೇಲ್‌ಗೆ ಕೋಡ್ ಕಳುಹಿಸಲು ಆಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.')
k('login.check_email','Check your email','अपना ईमेल देखें','ನಿಮ್ಮ ಇಮೇಲ್ ನೋಡಿ')
k('login.code_sent_email','We sent a 6-digit code to {{email}}. It can take a minute to arrive.','हमने {{email}} पर 6 अंकों का कोड भेजा है। आने में एक मिनट लग सकता है।','ನಾವು {{email}} ಗೆ 6 ಅಂಕಿಯ ಕೋಡ್ ಕಳುಹಿಸಿದ್ದೇವೆ. ಬರಲು ಒಂದು ನಿಮಿಷ ಆಗಬಹುದು.')
k('login.change_email','Use a different email','दूसरा ईमेल इस्तेमाल करें','ಬೇರೆ ಇಮೇಲ್ ಬಳಸಿ')

for i,lang in enumerate(['en','hi','kn']):
  d = {key: v[i] for key,v in sorted(T.items())}
  json.dump(d, open(f'{out}/{lang}.json','w'), ensure_ascii=False, indent=1)
print(len(T), 'keys')
