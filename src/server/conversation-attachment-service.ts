import { and, eq } from "drizzle-orm";
import { db, npcs, hermesProfiles } from "@/db";
import type { NpcAdapter } from "@/lib/adapters/types";
import type { ConversationRef } from "@/lib/conversation-attachments/types";
import type { PrepareRequest, PreparedFile } from "@/lib/conversation-attachments/server-types";
import { AttachmentServiceError, resolveAttachmentAccess, type AttachmentAccess } from "@/lib/conversation-attachments/access";
import { createRequest, getRequest, transitionRequest } from "@/lib/conversation-attachments/repository";
import { prepareAttachments, releasePreparedFiles, renewPreparedFiles, linkAttachments } from "@/lib/conversation-attachments/service";
import { validateAttachmentSelection } from "@/lib/conversation-attachments/policy";
import { registerAttachmentRequestHandlers, type AttachmentRequestView } from "@/lib/conversation-attachments/request-registry";
import { AttachmentExecution } from "./conversation-attachment-runtime";

export type AttachmentRuntimeTarget = { npcId: string; adapter: NpcAdapter; sessionKey: string };
type Input = {
 userId:string; channelId:string; conversation:ConversationRef; requestId:string; fileIds:string[]; messageId:string;
 targets():Promise<AttachmentRuntimeTarget[]>;
 validate?():Promise<void>;
 run(files:Record<string,PreparedFile[]>,signal:AbortSignal):Promise<void>;
 changed?(view:AttachmentRequestView):void;
};
const jobs=new Map<string,{execution:AttachmentExecution;contextId:string;userId:string}>();

export function parseAttachmentSend(value: {attachmentIds?:unknown;attachmentRequestId?:unknown;attachmentConversation?:unknown}, expected:ConversationRef): {fileIds:string[];requestId:string}|null {
 if(value.attachmentIds===undefined) return null;
 if(!Array.isArray(value.attachmentIds)||!value.attachmentIds.every(id=>typeof id==="string")) throw new AttachmentServiceError(400,"attachment_invalid_selection");
 const error=validateAttachmentSelection(value.attachmentIds);if(error)throw new AttachmentServiceError(400,error);
 if(!value.attachmentIds.length)return null;
 if(typeof value.attachmentRequestId!=="string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.attachmentRequestId))throw new AttachmentServiceError(400,"attachment_conflict");
 const ref=value.attachmentConversation as Partial<ConversationRef>|null;
 if(!ref || ref.kind!==expected.kind || ref.id!==expected.id)throw new AttachmentServiceError(409,"attachment_conflict");
 return {fileIds:value.attachmentIds,requestId:value.attachmentRequestId};
}

export async function submitAttachmentExecution(input:Input):Promise<void> {
 let access=await resolveAttachmentAccess(input.userId,input.channelId,input.conversation,"prepare");
 const targets=await input.targets();
 const targetIds=targets.map(t=>t.npcId).sort();
 const stored=await createRequest({id:input.requestId,contextId:access.context.id,senderId:input.userId,revision:access.context.revision,targets:targetIds,fileIds:input.fileIds});
 if(stored.contextId!==access.context.id || stored.senderId!==input.userId || stored.selectedFileIdsJson!==JSON.stringify(input.fileIds) || stored.targetSnapshotJson!==JSON.stringify(targetIds))throw new AttachmentServiceError(409,"attachment_conflict");
 if(jobs.has(input.requestId)||stored.status!=="pending")return;
 const request:PrepareRequest={requestId:input.requestId,conversation:input.conversation,revision:access.context.revision,fileIds:input.fileIds,targets:[]};
 const execution=new AttachmentExecution({
  transition:(from,to)=>transitionRequest(input.requestId,from,to),
  validate:async()=>{
   access=await resolveAttachmentAccess(input.userId,input.channelId,input.conversation,"prepare");
   await input.validate?.();
   if(access.context.revision!==request.revision || JSON.stringify((await input.targets()).map(t=>t.npcId).sort())!==JSON.stringify(targetIds))throw new AttachmentServiceError(409,"attachment_conflict");
   for(const target of targets) {
    const [row]=await db.select({id:npcs.id}).from(npcs).where(and(eq(npcs.id,target.npcId),eq(npcs.channelId,input.channelId),eq(npcs.active,true))).limit(1);
    if(!row)throw new AttachmentServiceError(404,"attachment_not_found");
   }
  },
  prepare:async()=>{
   request.targets=[];
   for(const target of targets){
    if(!target.adapter.ensureSession)throw new AttachmentServiceError(428,"attachment_feature_unavailable");
    const [profile]=await db.select({name:hermesProfiles.profileName}).from(npcs).innerJoin(hermesProfiles,eq(npcs.hermesProfileId,hermesProfiles.id)).where(and(eq(npcs.id,target.npcId),eq(hermesProfiles.gatewayId,access.gateway.id))).limit(1);
    if(!profile)throw new AttachmentServiceError(404,"attachment_not_found");
    request.targets.push({npcId:target.npcId,profileName:profile.name,sessionKey:target.sessionKey,sessionId:await target.adapter.ensureSession(target.sessionKey)});
   }
   await linkAttachments(access,input.fileIds,input.messageId);
   return prepareAttachments(access,request);
  },
  release:files=>releasePreparedFiles(access,request,files),
  renew:files=>renewPreparedFiles(access,request,files),
  run:input.run,
  changed:state=>input.changed?.({requestId:input.requestId,state,...(state==="failed"?{errorCode:"attachment_prepare_failed"}:{})}),
 });
 jobs.set(input.requestId,{execution,contextId:access.context.id,userId:input.userId});
 await execution.start();
}

async function control(access:AttachmentAccess,id:string,action:"retry"|"cancel"):Promise<AttachmentRequestView>{
 const row=await getRequest(id);
 if(!row || row.contextId!==access.context.id || row.senderId!==access.userId)throw new AttachmentServiceError(404,"attachment_not_found");
 const job=jobs.get(id);
 if(!job)throw new AttachmentServiceError(409,"attachment_conflict");
 if(action==="retry")void job.execution.retry();else await job.execution.cancel();
 return {requestId:id,state:(await getRequest(id))!.status};
}
export function registerSocketAttachmentRuntime(){
 registerAttachmentRequestHandlers({retry:(access,id)=>control(access,id,"retry"),cancel:(access,id)=>control(access,id,"cancel")});
}
export async function handleAttachmentRequestRpc(channelId:string,method:string,params:Record<string,unknown>){
 const access=await resolveAttachmentAccess(typeof params.userId==="string"?params.userId:null,channelId,params.conversation as ConversationRef,"prepare");
 return control(access,String(params.requestId),method==="attachment-request-retry"?"retry":"cancel");
}
