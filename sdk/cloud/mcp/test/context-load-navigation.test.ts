import { expect, it, vi } from 'vitest';
const fetcher=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/client.js',()=>({prismerFetch:fetcher}));
import { registerContextLoad } from '../src/tools/context-load';
it('default tool call shows outline and executable same-tool batch continuation',async()=>{
 let call:any;
 registerContextLoad({tool:(_name:any,_description:any,_schema:any,handler:any)=>{call=handler;}} as any);
 fetcher.mockResolvedValue({success:true,mode:'navigate',guidance:'Read refs',results:[{ref:'prismer://load/a/root',outline:[]}],next_calls:[{input:['ref1','ref2'],view:'content',budget:{maxTokens:4000}}]});
 const response=await call({input:'query'});
 expect(fetcher.mock.calls[0][1].body.view).toBe('navigate');
 const result=JSON.parse(response.content[0].text);
 expect(result.guidance).toBe('Read refs');
 expect(result.next_calls[0]).toEqual({tool:'prismer.context.load',arguments:{input:['ref1','ref2'],view:'content',maxTokens:4000}});
});
