import { Global, Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.service';
import { AiService } from './ai.service';
import { AriaService } from './aria.service';
import { ChatController } from './chat.controller';
import { ConversationsService } from '../inbox/conversations.service';
import { InboxController, NotificationsController } from '../inbox/inbox.controller';

@Global()
@Module({
  imports: [KnowledgeModule],
  controllers: [ChatController, InboxController, NotificationsController],
  providers: [AiService, AriaService, ConversationsService],
  exports: [AiService, AriaService, ConversationsService],
})
export class AiModule {}
