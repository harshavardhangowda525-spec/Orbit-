import { Injectable } from '@nestjs/common';
import { config } from '../config';
import { logger } from '../logger';

/** SMS adapter. Production uses a DLT-registered Indian provider behind this interface. */
export interface SmsSender {
  sendOtp(phone: string, code: string): Promise<void>;
}

@Injectable()
export class DevSmsSender implements SmsSender {
  async sendOtp(phone: string, code: string) {
    // Development only: the code is written to the server log instead of being sent.
    logger.log(`OTP for ${phone.slice(0, -4)}****: ${code}`, 'DevSms');
  }
}

export const SMS_SENDER = Symbol('SMS_SENDER');

export function smsSenderFactory(): SmsSender {
  switch (config.smsProvider) {
    case 'dev':
      return new DevSmsSender();
    default:
      throw new Error(`SMS provider "${config.smsProvider}" is not set up yet. Use SMS_PROVIDER=dev locally.`);
  }
}
