// Keyword denylists, ≥3 chars only (shorter idents are already dropped).
const JS = `abstract accessor any arguments as assert asserts async await bigint boolean
break case catch class const constructor continue debugger declare default delete
does else enum export extends false finally for from function get global if
implements import in infer instanceof interface intrinsic is keyof let module
namespace never new null number object of out override package private protected
public readonly require return satisfies set static string super switch symbol
this throw true try type typeof undefined unique unknown using var void while
with yield undefined`
const PY = `and as assert async await break class continue def del elif else except
false finally for from global import in is lambda none nonlocal not or pass print
raise return self true try while with yield cls match case type`
const GO = `break case chan const continue default defer else fallthrough for func
goto import interface map package range return select struct switch type var nil
true false string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64
float32 float64 byte rune bool error len cap make new append copy delete panic
recover print println complex real imag close iota any`
const RUST = `abstract as async await become box break const continue crate dyn else
enum extern false final fnn for if impl in let loop macro match mod move mut
override priv pub ref return self static struct super trait true try type typeof
union unsafe unsized use virtual where while yield str bool char usize isize
i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 Self`
const JVM = `abstract actual annotation any as assert boolean break byte case catch
char class companion const constructor continue crossinline data def default
delegate do double dynamic else enum expect extends external false final finally
float for fun goto if implements import in infix init inline instanceof int
interface internal is lateinit long native new noinline null object open operator
out override package param private property protected public reified return
sealed short static strictfp super suspend switch synchronized tailrec this throw
throws trait transient true try typealias typeof val var vararg void volatile
when where while with yield`
const CSHARP = `abstract add alias and args as ascending async await base bool break
byte case catch char checked class const continue decimal default delegate
descending do double dynamic else enum equals event explicit extern false finally
fixed float for foreach from get global goto group if implicit import in init int
interface internal into is join let lock long managed nameof namespace new nint
not notnull nuint null object on operator or orderby out override params partial
private protected public readonly record ref remove return sbyte sealed select
set short sizeof stackalloc static string struct switch this throw true try
typeof uint ulong unchecked unmanaged unsafe ushort using value var virtual void
volatile when where while with yield`
const CFAM = `alignas alignof and asm auto bitand bitor bool break case catch char
char8_t char16_t char32_t class compl concept const consteval constexpr constinit
const_cast continue co_await co_return co_yield decltype default delete double
dynamic_cast else enum explicit export extern false float for friend goto if
inline int long mutable namespace new noexcept not nullptr operator or private
protected public register reinterpret_cast requires restrict return short signed
sizeof static static_assert static_cast struct switch template this thread_local
throw true try typedef typeid typename union unsigned using virtual void volatile
wchar_t while xor include define ifdef ifndef endif pragma elif undef error
defined line NULL size_t printf sprintf malloc free memcpy memset strlen`
const PHP = `abstract and array as break callable case catch class clone const
continue declare default die do echo else elseif empty enddeclare endfor endforeach
endif endswitch endwhile enum extends final finally fnn for foreach function
global goto if implements include include_once instanceof insteadof interface
isset list match namespace new null print private protected public readonly
require require_once return static switch throw trait try unset use var while
xor yield true false int float string bool void mixed iterable object self
parent echo printf sprintf count array_map array_filter`
const SWIFT = `actor any as associatedtype associativity async await borrowing break
case catch class consuming continue convenience default defer deinit didSet do
dynamic else enum extension fallthrough false fileprivate final for func get
guard if import in indirect infix init inout internal is lazy let mutating
nil none nonisolated nonmutating open operator optional override postfix precedence
precedencegroup prefix private protocol public repeat required rethrows return
self Self set some static struct subscript super switch throw throws true try
typealias unowned var weak where while willSet Int String Double Bool Array
Dictionary Optional Void Error Result`
const BASH= `alias bash bg break builtin case cat cd chmod command continue cp
declare dirname do done echo elif else esac eval exec exit export false fi file
for function getopts grep head hash if in local ls mkdir mv printf pwd read
readonly return rm sed set shift source test then time trap true type typeset
umask unalias unset until wait while awk cut sort uniq tail tee xargs env expr
basename touch which sleep kill exit shopt IFS PATH HOME PWD OLDPWD BASH_SOURCE
FUNCNAME RANDOM SECONDS LINENO`
const RUBY = `alias and begin break case class def defined do else elsif end ensure
false for if in module next nil not or redo rescue retry return self super then
true undef unless until when while yield attr_accessor attr_reader attr_writer
require require_relative include extend puts print raise lambda proc new
initialize private protected public module_function`
const LUA = `and break do else elseif end false for function goto if in local nil
not or repeat return then true until while self print pairs ipairs require
tostring tonumber type table string math error assert pcall setmetatable
getmetatable rawget rawset select unpack next`
const SQL = `add all alter and any array as asc between by cascade case cast check
column commit constraint create cross current database default delete desc
distinct drop else end exists external false fetch first foreign from full
function grant group having if in index inner insert int integer intersect into
is join key left like limit not null nulls offset on or order outer primary
procedure references rename replace restrict returns right rollback row rows
schema select set table temporary then to trigger true union unique update using
values varchar view when where with boolean char date decimal double float text
timestamp bigint smallint numeric`
const CSS = `absolute after all and animation attr auto background before block
block-size body border bottom box calc center color column content cursor
default display flex float font from grid height hidden hover import important
inherit initial inline inset italic keyframes left linear margin max media min
none normal not only opacity outline overflow padding position relative right
rgba rotate scale screen solid supports text top transform transition translate
transparent unset url var visible weight white width wrap zindex px rem
important root and or media supports layer container`
const HTML = `alt aria body br button charset checked class col colspan content
data-testid dir disabled div doctype figure footer form head header height href
html img input label lang li link main meta name nav ol option placeholder pre
rel role script section select span src style table tbody td textarea tfoot th
thead title tr type ul value viewport width xmlns button strong span div utf-8`
const GQL = `directive else enum extend false fragment implements input interface
mutation null on query scalar schema subscription true type union Int Float
String Boolean ID deprecated skip include specifiedBy`
const TF = `bool count data depends_on dynamic each else false for for_each function
if import list local locals map module moved number object optional output
provider provisioner required_providers required_version resource set string
terraform true tuple type validation value var variable version any check
import removed lifecycle backend`

function set(s: string): Set<string> {
  return new Set(
    s
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 3),
  )
}

const JS_SET = set(JS)
const JVM_SET = set(JVM)
const CFAM_SET = set(CFAM)

export const KEYWORDS: Record<string, Set<string>> = {
  typescript: JS_SET,
  javascript: JS_SET,
  python: set(PY),
  go: set(GO),
  rust: set(RUST),
  java: JVM_SET,
  kotlin: JVM_SET,
  scala: JVM_SET,
  groovy: JVM_SET,
  dart: JVM_SET,
  csharp: set(CSHARP),
  c: CFAM_SET,
  php: set(PHP),
  swift: set(SWIFT),
  bash: set(BASH),
  ruby: set(RUBY),
  lua: set(LUA),
  sql: set(SQL),
  css: set(CSS),
  html: set(HTML),
  xml: set(HTML),
  graphql: set(GQL),
  terraform: set(TF),
  elixir: set(RUBY),
  powershell: set(BASH),
}
