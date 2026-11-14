import { Global, Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.service';
import { AiService } from './ai.service';
import { UsageService } from '../billing/usage.service';
import { AriaService } from './aria.service';
import { AssistantService } from './assistant.service';
import { ChatController } from './chat.controller';
import { ConversationsService } from '../inbox/conversations.service';
import { InboxController, NotificationsController } from '../inbox/inbox.controller';

@Global()
@Module({
  imports: [KnowledgeModule],
  controllers: [ChatController, InboxController, NotificationsController],
  providers: [AiService, AriaService, AssistantService, ConversationsService, UsageService],
  exports: [AiService, AriaService, AssistantService, ConversationsService, UsageService],
})
export class AiModule {}
