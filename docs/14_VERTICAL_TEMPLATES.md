# 14 — Vertical Templates

## Template Contract
Each template must include industry, agent type, goals, required fields, default greeting, call flow, tools, transfer rules, compliance defaults, analytics success metrics, and test scenarios.

## MVP Templates

### 1. AI Receptionist
General inbound answering. Fields: name, phone, reason_for_call, preferred_callback_time. Tools: create_lead, send_sms, transfer_call.

### 2. Dental Clinic Receptionist
Patient calls, bookings, urgent transfer. Fields: full_name, phone, existing_patient, treatment_needed, preferred_date, preferred_time. Transfer: severe pain, bleeding, swelling, human request, agent uncertain.

### 3. Real Estate Lead Qualifier
Fields: name, phone, budget, location, property_type, timeline, visit_time. Hot lead: has budget, wants site visit, timeline under 30 days.

### 4. Appointment Reminder
Outbound opt-in reminder. Goals: confirm, reschedule, cancel, update calendar. Compliance: consent required, opt-out enabled, call window enforced.

### 5. D2C Order Confirmation
Goals: confirm order, address, COD/prepaid preference, send payment link. Fields: order_id, customer_name, phone, address_confirmed, order_confirmed.

## Future Templates
Salon/spa booking, gym membership follow-up, event planner inquiry, recruitment screening, restaurant reservation, education admission counselor, home services quote/booking.
