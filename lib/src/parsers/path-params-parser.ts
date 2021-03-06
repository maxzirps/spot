import { ParameterDeclaration, PropertySignature } from "ts-morph";
import { Example, PathParam } from "../definitions";
import { OptionalNotAllowedError, ParserError } from "../errors";
import { isPathParamTypeSafe } from "../http";
import { LociTable } from "../locations";
import { stringType, Type, TypeKind, TypeTable } from "../types";
import { err, ok, Result } from "../util";
import {
  getJsDoc,
  getParameterTypeAsTypeLiteralOrThrow,
  getPropertyName
} from "./parser-helpers";
import { parseType } from "./type-parser";

export function parsePathParams(
  parameter: ParameterDeclaration,
  typeTable: TypeTable,
  lociTable: LociTable
): Result<PathParam[], ParserError> {
  parameter.getDecoratorOrThrow("pathParams");
  if (parameter.hasQuestionToken()) {
    return err(
      new OptionalNotAllowedError("@pathParams parameter cannot be optional", {
        file: parameter.getSourceFile().getFilePath(),
        position: parameter.getQuestionTokenNodeOrThrow().getPos()
      })
    );
  }
  const pathParamTypeLiteral = getParameterTypeAsTypeLiteralOrThrow(parameter);

  const pathParams = [];
  for (const propertySignature of pathParamTypeLiteral.getProperties()) {
    const pathParamResult = extractPathParam(
      propertySignature,
      typeTable,
      lociTable
    );
    if (pathParamResult.isErr()) return pathParamResult;
    pathParams.push(pathParamResult.unwrap());
  }

  return ok(pathParams.sort((a, b) => (b.name > a.name ? -1 : 1)));
}

function extractPathParam(
  propertySignature: PropertySignature,
  typeTable: TypeTable,
  lociTable: LociTable
): Result<PathParam, ParserError> {
  if (propertySignature.hasQuestionToken()) {
    return err(
      new OptionalNotAllowedError("@pathParams property cannot be optional", {
        file: propertySignature.getSourceFile().getFilePath(),
        position: propertySignature.getQuestionTokenNodeOrThrow().getPos()
      })
    );
  }

  const nameResult = extractPathParamName(propertySignature);
  if (nameResult.isErr()) return nameResult;
  const name = nameResult.unwrap();

  const typeResult = extractPathParamType(
    propertySignature,
    typeTable,
    lociTable
  );
  if (typeResult.isErr()) return typeResult;
  const type = typeResult.unwrap();

  const description = getJsDoc(propertySignature)?.getDescription().trim();

  const examples = extractPathParamExamples(propertySignature, type);
  if (examples && examples.isErr()) return examples;

  if (examples) {
    return ok({
      name,
      type,
      description,
      examples: examples.unwrap()
    });
  }

  return ok({
    name,
    type,
    description
  });
}

function extractPathParamExamples(
  propertySignature: PropertySignature,
  type: Type
): Result<Example[], ParserError> | undefined {
  const rawExamples = getJsDoc(propertySignature)
    ?.getTags()
    .filter(tag => tag.getTagName() === "example")
    .map(example => example.getComment());

  if (rawExamples && rawExamples.indexOf(undefined) !== -1) {
    return err(
      new ParserError("@pathParams example must not be empty", {
        file: propertySignature.getSourceFile().getFilePath(),
        position: propertySignature.getPos()
      })
    );
  }

  if (rawExamples && rawExamples.length > 0) {
    const examples: Example[] = [];
    let exampleError;
    rawExamples.every(example => {
      const exampleName = example?.split("\n")[0]?.trim();
      const exampleValue = example?.split("\n")[1]?.trim();
      if (!exampleName || !exampleValue) {
        exampleError = err(
          new ParserError("@pathParams malformed example", {
            file: propertySignature.getSourceFile().getFilePath(),
            position: propertySignature.getPos()
          })
        );
        return false;
      } else {
        if (examples.some(ex => ex.name === exampleName)) {
          exampleError = err(
            new ParserError("@pathParams duplicate example name", {
              file: propertySignature.getSourceFile().getFilePath(),
              position: propertySignature.getPos()
            })
          );
          return false;
        }

        if (
          type.kind === TypeKind.STRING &&
          (!exampleValue.startsWith('"') || !exampleValue.endsWith('"'))
        ) {
          return err(
            new ParserError("@pathParams string examples must be quoted", {
              file: propertySignature.getSourceFile().getFilePath(),
              position: propertySignature.getPos()
            })
          );
        }

        try {
          const parsedValue = JSON.parse(exampleValue);
          examples.push({ name: exampleName, value: parsedValue });
        } catch (e) {
          exampleError = err(
            new ParserError("could not parse @pathParams example", {
              file: propertySignature.getSourceFile().getFilePath(),
              position: propertySignature.getPos()
            })
          );
          return false;
        }

        return true;
      }
    });
    if (exampleError) {
      return exampleError;
    }

    const typeOf = (value: string): string => {
      if (/^-?\d+$/.test(value)) {
        return "number";
      }

      if (typeof value === "boolean") {
        return "boolean";
      }

      return "string";
    };

    const typeOfExamples: string[] = examples.map(ex => {
      return typeOf(ex.value);
    });

    const spotTypesToJSTypesMap = new Map();
    spotTypesToJSTypesMap.set(TypeKind.INT32, "number");
    spotTypesToJSTypesMap.set(TypeKind.INT64, "number");
    spotTypesToJSTypesMap.set(TypeKind.FLOAT, "number");
    spotTypesToJSTypesMap.set(TypeKind.DOUBLE, "number");

    const typeSpecified: string =
      spotTypesToJSTypesMap.get(type.kind) || type.kind;

    if (typeOfExamples.some(typeOfExample => typeOfExample !== typeSpecified)) {
      return err(
        new ParserError(
          "@pathParams type of example must match type of param",
          {
            file: propertySignature.getSourceFile().getFilePath(),
            position: propertySignature.getPos()
          }
        )
      );
    }

    return ok(examples);
  }
  return;
}
function extractPathParamName(
  propertySignature: PropertySignature
): Result<string, ParserError> {
  const name = getPropertyName(propertySignature);
  if (!/^[\w-]*$/.test(name)) {
    return err(
      new ParserError(
        "@pathParams property name may only contain alphanumeric, underscore and hyphen characters",
        {
          file: propertySignature.getSourceFile().getFilePath(),
          position: propertySignature.getPos()
        }
      )
    );
  }
  if (name.length === 0) {
    return err(
      new ParserError("@pathParams property name must not be empty", {
        file: propertySignature.getSourceFile().getFilePath(),
        position: propertySignature.getPos()
      })
    );
  }
  return ok(name);
}

function extractPathParamType(
  propertySignature: PropertySignature,
  typeTable: TypeTable,
  lociTable: LociTable
): Result<Type, ParserError> {
  const typeResult = parseType(
    propertySignature.getTypeNodeOrThrow(),
    typeTable,
    lociTable
  );
  if (typeResult.isErr()) return typeResult;

  if (!isPathParamTypeSafe(typeResult.unwrap(), typeTable)) {
    return err(
      new ParserError(
        "path parameter type may only be a URL-safe type, or an array of URL-safe types",
        {
          file: propertySignature.getSourceFile().getFilePath(),
          position: propertySignature.getPos()
        }
      )
    );
  }
  return typeResult;
}
