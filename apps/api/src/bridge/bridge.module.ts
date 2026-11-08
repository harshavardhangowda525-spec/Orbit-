import { Module } from '@nestjs/common';
import { BridgeController } from './bridge.controller';
import { BridgeService } from './bridge.service';

@Module({ controllers: [BridgeController], providers: [BridgeService] })
export class BridgeModule {}
