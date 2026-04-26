/**
 * MVP industry tags. Kept as an open string in the Agent Spec so users can
 * pick from this list or type a custom value. Used for template filtering
 * and analytics grouping.
 */
export const MVP_INDUSTRIES = [
  'general_smb',
  'dental_clinic',
  'medical_clinic',
  'real_estate',
  'appointment_services',
  'ecommerce_d2c',
  'salon_spa',
  'gym_fitness',
  'education',
  'home_services',
] as const;

export type MvpIndustry = (typeof MVP_INDUSTRIES)[number];
