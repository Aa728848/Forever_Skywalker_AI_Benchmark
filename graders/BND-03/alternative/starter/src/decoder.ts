export class InvalidUtf8Error extends Error { readonly offset:number; constructor(offset:number){super('invalid UTF-8 at '+offset);this.name='InvalidUtf8Error';this.offset=offset;} }
export class IncompleteSequenceError extends Error {constructor(message='incomplete UTF-8'){super(message);this.name='IncompleteSequenceError';}}
export class StreamDecoder {
 private received=0;private tail:number[]=[];private closed=false;private failure:Error|undefined;
 get offset():number{return this.received;}
 push(bytes:Uint8Array):string{
  if(this.failure)throw this.failure;if(this.closed)throw new IncompleteSequenceError('decoder ended');
  const base=this.received-this.tail.length;this.received+=bytes.length;const input=Uint8Array.from([...this.tail,...bytes]);this.tail=[];let index=0;
  const invalid=(at:number)=>{this.failure=new InvalidUtf8Error(base+at);throw this.failure;};
  while(index<input.length){const lead=input[index]!;let length=lead<128?1:lead>=194&&lead<=223?2:lead>=224&&lead<=239?3:lead>=240&&lead<=244?4:0;if(length===0)invalid(index);
   for(let offset=1;offset<length&&index+offset<input.length;offset++){const byte=input[index+offset]!;if(byte<128||byte>191||(offset===1&&((lead===224&&byte<160)||(lead===237&&byte>159)||(lead===240&&byte<144)||(lead===244&&byte>143))))invalid(index);}
   if(index+length>input.length){this.tail=Array.from(input.subarray(index));break;}index+=length;
  }
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input.subarray(0,index));
 }
 end():string{if(this.failure)throw this.failure;if(this.closed)return '';this.closed=true;if(this.tail.length){this.tail=[];this.failure=new IncompleteSequenceError();throw this.failure;}return '';}
}
